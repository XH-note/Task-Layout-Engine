import { create } from 'zustand';

import type { PlanRecord } from '../shared/plan';
import { ApiError, generatePlan, getPlan } from './api';
import { readStorageValue, writeStorageValue } from './browser-storage';
import { mapGenerationFailure, type GenerationFailure } from './generation-errors';

const CURRENT_PLAN_KEY = 'task-layout:current-plan-id';
const GENERATING_KEY = 'task-layout:generating';

export type GenerationPhase = 'idle' | 'generating' | 'failed' | 'busy';

export type GenerationState =
  | { phase: 'idle' }
  | { phase: 'generating'; startedAt: number }
  | { phase: 'failed'; failure: GenerationFailure }
  | { phase: 'busy' };

type PlanState = {
  record: PlanRecord | null;
  generation: GenerationState;
  interrupted: boolean;
  notice: string | null;
  restored: boolean;
  restore: () => Promise<void>;
  generate: (source: string) => Promise<void>;
  cancel: () => void;
  newPlan: () => void;
  dismissIssue: () => void;
  dismissInterrupted: () => void;
  dismissNotice: () => void;
};

let activeController: AbortController | null = null;

function readCurrentPlanId(): string | null {
  return readStorageValue('local', CURRENT_PLAN_KEY);
}

function writeCurrentPlanId(id: string | null) {
  writeStorageValue('local', CURRENT_PLAN_KEY, id);
}

function setGeneratingFlag(value: boolean) {
  writeStorageValue('session', GENERATING_KEY, value ? '1' : null);
}

export const usePlanStore = create<PlanState>((set, get) => ({
  record: null,
  generation: { phase: 'idle' },
  interrupted: false,
  notice: null,
  restored: false,

  restore: async () => {
    if (get().restored) return;

    const interrupted = readStorageValue('session', GENERATING_KEY) === '1';
    if (interrupted) setGeneratingFlag(false);
    set({ restored: true, interrupted });

    const id = readCurrentPlanId();
    if (!id) return;

    try {
      const record = await getPlan(id);
      if (get().record !== null) return;
      set({ record });
    } catch (error) {
      if (error instanceof ApiError && error.code === 'NOT_FOUND') {
        writeCurrentPlanId(null);
      }
    }
  },

  generate: async (source) => {
    if (get().generation.phase === 'generating' || !source.trim()) return;

    const controller = new AbortController();
    activeController = controller;
    setGeneratingFlag(true);
    set({
      generation: { phase: 'generating', startedAt: Date.now() },
      interrupted: false,
      notice: null,
    });

    try {
      const { record } = await generatePlan(source, controller.signal);
      if (activeController !== controller) return;

      writeCurrentPlanId(record.id);
      set({ record, generation: { phase: 'idle' } });
    } catch (error) {
      if (activeController !== controller) return;

      if (error instanceof ApiError && error.code === 'CANCELLED') {
        set({ generation: { phase: 'idle' }, notice: '已取消生成。' });
      } else if (error instanceof ApiError && error.code === 'BUSY') {
        set({ generation: { phase: 'busy' }, notice: null });
      } else {
        set({
          generation: {
            phase: 'failed',
            failure: mapGenerationFailure(error instanceof ApiError ? error : null),
          },
          notice: null,
        });
      }
    } finally {
      if (activeController === controller) {
        activeController = null;
        setGeneratingFlag(false);
      }
    }
  },

  cancel: () => {
    if (get().generation.phase !== 'generating') return;

    const controller = activeController;
    activeController = null;
    controller?.abort();
    setGeneratingFlag(false);
    set({ generation: { phase: 'idle' }, notice: '已取消生成。' });
  },

  newPlan: () => {
    const wasGenerating = get().generation.phase === 'generating';
    if (wasGenerating) get().cancel();

    writeCurrentPlanId(null);
    set({
      record: null,
      generation: { phase: 'idle' },
      interrupted: false,
      notice: wasGenerating ? '已取消生成。' : null,
    });
  },

  dismissIssue: () => {
    const phase = get().generation.phase;
    if (phase !== 'failed' && phase !== 'busy') return;
    set({ generation: { phase: 'idle' } });
  },

  dismissInterrupted: () => {
    if (!get().interrupted) return;
    set({ interrupted: false });
  },

  dismissNotice: () => {
    if (get().notice === null) return;
    set({ notice: null });
  },
}));
