import { create } from 'zustand';

import type { PlanRecord } from '../shared/plan';
import { ApiError, generatePlan, getPlan } from './api';
import { readStorageValue, writeStorageValue } from './browser-storage';

const CURRENT_PLAN_KEY = 'task-layout:current-plan-id';
const GENERATING_KEY = 'task-layout:generating';

export type GenerationPhase = 'idle' | 'generating' | 'failed' | 'busy';

export type GenerationState =
  | { phase: 'idle' }
  | { phase: 'generating'; startedAt: number }
  | { phase: 'failed'; message: string }
  | { phase: 'busy' };

type PlanState = {
  record: PlanRecord | null;
  generation: GenerationState;
  interrupted: boolean;
  restored: boolean;
  restore: () => Promise<void>;
  generate: (source: string) => Promise<void>;
  dismissIssue: () => void;
  dismissInterrupted: () => void;
};

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

    setGeneratingFlag(true);
    set({
      generation: { phase: 'generating', startedAt: Date.now() },
      interrupted: false,
    });

    try {
      const { record } = await generatePlan(source);
      setGeneratingFlag(false);
      writeCurrentPlanId(record.id);
      set({ record, generation: { phase: 'idle' } });
    } catch (error) {
      setGeneratingFlag(false);

      if (error instanceof ApiError && error.code === 'BUSY') {
        set({ generation: { phase: 'busy' } });
      } else {
        set({
          generation: { phase: 'failed', message: '生成失败，请稍后重试。' },
        });
      }
    }
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
}));
