import { create } from 'zustand';

import {
  comparePlansByUpdatedAt,
  createLeafDraft,
  insertChildNode,
  MAX_TASK_DEPTH,
  movePlanNode,
  removePlanNode,
  toPlanListItem,
  updatePlanNode,
  validatePlan,
  type PlanHistoryUsage,
  type PlanIssue,
  type PlanListItem,
  type PlanNode,
  type PlanRecord,
  type PlanDropTarget,
} from '../shared/plan';
import {
  ApiError,
  clearPlans as clearPlansRequest,
  deletePlan as deletePlanRequest,
  generatePlan,
  getPlan,
  listPlans,
  regenerateLeaf as regenerateLeafRequest,
  updatePlan,
} from './api';
import { readStorageValue, writeStorageValue } from './browser-storage';
import { mapGenerationFailure, type GenerationFailure } from './generation-errors';

const CURRENT_PLAN_KEY = 'task-layout:current-plan-id';
const GENERATING_KEY = 'task-layout:generating';
export const SAVE_DEBOUNCE_MS = 800;

export type GenerationPhase = 'idle' | 'generating' | 'failed' | 'busy';

export type GenerationState =
  | { phase: 'idle' }
  | { phase: 'generating'; startedAt: number }
  | { phase: 'failed'; failure: GenerationFailure }
  | { phase: 'busy' };

export type SaveState =
  | { status: 'idle' }
  | { status: 'dirty' }
  | { status: 'saving' }
  | { status: 'invalid'; message: string }
  | { status: 'error'; message: string };

type PlanState = {
  record: PlanRecord | null;
  generation: GenerationState;
  interrupted: boolean;
  notice: string | null;
  restored: boolean;
  selectedNodeId: string | null;
  saveState: SaveState;
  editError: string | null;
  regeneratingNodeId: string | null;
  regenerateError: string | null;
  history: PlanListItem[];
  usage: PlanHistoryUsage;
  historyLoading: boolean;
  historyError: string | null;
  restore: () => Promise<void>;
  generate: (source: string) => Promise<void>;
  cancel: () => void;
  newPlan: () => Promise<void>;
  refreshHistory: () => Promise<void>;
  switchPlan: (id: string) => Promise<boolean>;
  removePlan: (id: string) => Promise<boolean>;
  clearHistory: () => Promise<boolean>;
  renamePlan: (title: string) => void;
  selectNode: (id: string | null) => void;
  updateNode: (id: string, patch: Partial<PlanNode>) => void;
  addChildNode: (parentId: string) => string | null;
  deleteNode: (
    id: string,
  ) => { removedNodes: number; clearedDependencies: number } | null;
  moveNode: (draggedId: string, target: PlanDropTarget) => boolean;
  regenerateNode: (nodeId: string) => Promise<void>;
  saveNow: (options?: { keepalive?: boolean }) => Promise<void>;
  retrySave: () => Promise<void>;
  dismissIssue: () => void;
  dismissInterrupted: () => void;
  dismissNotice: () => void;
};

let activeController: AbortController | null = null;
let regenerateController: AbortController | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let editRevision = 0;
let saving = false;
let saveChain: Promise<void> = Promise.resolve();
let historyRequest = 0;

function readCurrentPlanId(): string | null {
  return readStorageValue('local', CURRENT_PLAN_KEY);
}

function writeCurrentPlanId(id: string | null) {
  writeStorageValue('local', CURRENT_PLAN_KEY, id);
}

function setGeneratingFlag(value: boolean) {
  writeStorageValue('session', GENERATING_KEY, value ? '1' : null);
}

function clearSaveTimer() {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

function readFirstIssue(detail: unknown): PlanIssue | null {
  if (!Array.isArray(detail)) return null;

  for (const item of detail) {
    if (typeof item !== 'object' || item === null) continue;

    const issue = item as { path?: unknown; message?: unknown };
    if (typeof issue.path === 'string' && typeof issue.message === 'string') {
      return { path: issue.path, message: issue.message };
    }
  }

  return null;
}

function describeIssue(issue: PlanIssue | undefined): string {
  return issue
    ? `校验未通过：${issue.message}`
    : '校验未通过，修改暂未保存。';
}

function describeSaveFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return '保存失败，修改暂未写入。';
  }

  if (error.code === 'NETWORK_ERROR') {
    return '无法连接本地服务，修改暂未保存。';
  }

  if (error.code === 'NOT_FOUND') {
    return '这份任务计划书已不存在，无法保存。';
  }

  if (error.code === 'INTEGRITY') {
    const issue = readFirstIssue(error.detail);
    return issue ? `校验未通过：${issue.message}` : error.message;
  }

  if (error.code === 'STORAGE') {
    return '写入本机数据文件失败，修改暂未保存。';
  }

  return error.message || '保存失败，修改暂未写入。';
}

function describeRegenerationFailure(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return '重新生成失败，请重试。';
  }

  if (error.code === 'NETWORK_ERROR') {
    return '无法连接本地服务，重新生成失败。';
  }

  if (error.code === 'BUSY') {
    return '已有生成任务正在进行，请稍后再试。';
  }

  if (error.code === 'CONFLICT') {
    return '计划已被其他操作修改，请重新尝试。';
  }

  if (error.code === 'NOT_FOUND') {
    return '该任务或计划书已不存在，无法重新生成。';
  }

  if (error.code === 'INTEGRITY' || error.code === 'OUTPUT_INVALID') {
    const issue = readFirstIssue(error.detail);
    return issue
      ? `重新生成结果未通过校验：${issue.message}`
      : error.message;
  }

  return error.message || '重新生成失败，请重试。';
}

function sortHistory(items: PlanListItem[]): PlanListItem[] {
  return [...items].sort(comparePlansByUpdatedAt);
}

function upsertHistory(history: PlanListItem[], record: PlanRecord): PlanListItem[] {
  return sortHistory([
    toPlanListItem(record),
    ...history.filter((item) => item.id !== record.id),
  ]);
}

export const usePlanStore = create<PlanState>((set, get) => {
  function scheduleSave() {
    clearSaveTimer();
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void requestSave();
    }, SAVE_DEBOUNCE_MS);
  }

  function abortRegeneration() {
    const controller = regenerateController;
    regenerateController = null;
    controller?.abort();
  }

  async function performSave(keepalive = false): Promise<void> {
    const state = get();
    const record = state.record;
    if (!record) return;

    if (state.saveState.status === 'idle' || state.saveState.status === 'saving') {
      return;
    }

    clearSaveTimer();

    const issues = validatePlan(record.plan);
    if (issues.length > 0) {
      set({
        saveState: { status: 'invalid', message: describeIssue(issues[0]) },
      });
      return;
    }

    const revision = editRevision;
    saving = true;
    set({ saveState: { status: 'saving' } });

    try {
      const saved = await updatePlan(
        record.id,
        { title: record.title, plan: record.plan },
        { keepalive },
      );

      const current = get().record;
      if (!current || current.id !== record.id) return;

      if (editRevision === revision) {
        set((state) => ({
          record: saved,
          saveState: { status: 'idle' },
          history: upsertHistory(state.history, saved),
        }));
      } else {
        const updated = { ...current, updatedAt: saved.updatedAt };
        set((state) => ({
          record: updated,
          saveState: { status: 'dirty' },
          history: upsertHistory(state.history, updated),
        }));
        scheduleSave();
      }
    } catch (error) {
      if (get().record?.id !== record.id) return;
      set({ saveState: { status: 'error', message: describeSaveFailure(error) } });
    } finally {
      saving = false;
    }
  }

  function requestSave(keepalive = false): Promise<void> {
    const run = saveChain.then(() => performSave(keepalive));
    saveChain = run.catch(() => undefined);
    return run;
  }

  function flushKeepalive() {
    const record = get().record;
    if (!record) return;
    if (validatePlan(record.plan).length > 0) return;

    void updatePlan(
      record.id,
      { title: record.title, plan: record.plan },
      { keepalive: true },
    ).catch(() => undefined);
  }

  return {
    record: null,
    generation: { phase: 'idle' },
    interrupted: false,
    notice: null,
    restored: false,
    selectedNodeId: null,
    saveState: { status: 'idle' },
    editError: null,
    regeneratingNodeId: null,
    regenerateError: null,
    history: [],
    usage: { count: 0, bytes: 0 },
    historyLoading: false,
    historyError: null,

    restore: async () => {
      if (get().restored) return;

      const interrupted = readStorageValue('session', GENERATING_KEY) === '1';
      if (interrupted) setGeneratingFlag(false);
      set({ restored: true, interrupted });
      void get().refreshHistory();

      const id = readCurrentPlanId();
      if (!id) return;

      try {
        const record = await getPlan(id);
        if (get().record !== null) return;
        set({
          record,
          selectedNodeId: null,
          saveState: { status: 'idle' },
          editError: null,
          regenerateError: null,
        });
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_FOUND') {
          writeCurrentPlanId(null);
        }
      }
    },

    generate: async (source) => {
      if (get().generation.phase === 'generating' || !source.trim()) return;

      abortRegeneration();
      set({ regeneratingNodeId: null, regenerateError: null });
      await get().saveNow();
      clearSaveTimer();
      editRevision += 1;

      const controller = new AbortController();
      activeController = controller;
      setGeneratingFlag(true);
      set({
        generation: { phase: 'generating', startedAt: Date.now() },
        interrupted: false,
        notice: null,
        saveState: { status: 'idle' },
        editError: null,
      });

      try {
        const { record } = await generatePlan(source, controller.signal);
        if (activeController !== controller) return;

        writeCurrentPlanId(record.id);
        set({
          record,
          generation: { phase: 'idle' },
          selectedNodeId: null,
          saveState: { status: 'idle' },
          editError: null,
          regeneratingNodeId: null,
          regenerateError: null,
        });
        void get().refreshHistory();
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

    newPlan: async () => {
      abortRegeneration();
      set({ regeneratingNodeId: null, regenerateError: null });
      const wasGenerating = get().generation.phase === 'generating';
      if (wasGenerating) get().cancel();

      if (get().record) {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await get().saveNow();
          if (get().saveState.status !== 'dirty') break;
        }

        const status = get().saveState.status;
        if (
          status === 'error' ||
          status === 'invalid' ||
          status === 'dirty' ||
          status === 'saving'
        ) {
          set({ notice: '修改尚未保存，暂无法新建计划。请先处理保存问题。' });
          return;
        }
      }

      clearSaveTimer();
      editRevision += 1;
      writeCurrentPlanId(null);
      set({
        record: null,
        generation: { phase: 'idle' },
        interrupted: false,
        notice: wasGenerating ? '已取消生成。' : null,
        selectedNodeId: null,
        saveState: { status: 'idle' },
        editError: null,
        regeneratingNodeId: null,
        regenerateError: null,
      });
    },

    refreshHistory: async () => {
      const requestId = (historyRequest += 1);
      set({ historyLoading: true });

      try {
        const data = await listPlans();
        if (requestId !== historyRequest) return;

        const current = get().record;
        const plans = current
          ? data.plans.map((item) =>
              item.id === current.id ? { ...item, title: current.title } : item,
            )
          : data.plans;

        set({
          history: plans,
          usage: data.usage,
          historyLoading: false,
          historyError: null,
        });
      } catch {
        if (requestId !== historyRequest) return;

        set({
          historyLoading: false,
          historyError: '无法读取历史记录，请稍后重试。',
        });
      }
    },

    switchPlan: async (id) => {
      const state = get();
      if (state.record?.id === id) return true;

      abortRegeneration();
      set({ regeneratingNodeId: null, regenerateError: null });
      const wasGenerating = state.generation.phase === 'generating';
      if (wasGenerating) get().cancel();

      await get().saveNow();

      const status = get().saveState.status;
      if (
        status === 'error' ||
        status === 'invalid' ||
        status === 'dirty' ||
        status === 'saving'
      ) {
        set({ notice: '当前修改尚未保存，暂不能切换计划。请先处理保存问题。' });
        return false;
      }

      try {
        const record = await getPlan(id);
        writeCurrentPlanId(id);
        set({
          record,
          selectedNodeId: null,
          saveState: { status: 'idle' },
          editError: null,
          regeneratingNodeId: null,
          regenerateError: null,
          historyError: null,
          notice: wasGenerating ? '已取消生成。' : null,
        });
        return true;
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_FOUND') {
          set({ historyError: '这份计划书已不存在，已从历史中移除。' });
          void get().refreshHistory();
        } else {
          set({ historyError: '加载计划失败，请稍后重试。' });
        }

        return false;
      }
    },

    removePlan: async (id) => {
      abortRegeneration();
      set({ regeneratingNodeId: null, regenerateError: null });
      const current = get().record?.id === id;
      if (current && get().generation.phase === 'generating') get().cancel();

      if (current) {
        if (get().saveState.status === 'saving') await saveChain;
        clearSaveTimer();
      }

      try {
        await deletePlanRequest(id);
      } catch (error) {
        if (error instanceof ApiError && error.code === 'NOT_FOUND') {
          set({ historyError: '这份计划书已不存在。' });
          void get().refreshHistory();
        } else {
          set({ historyError: '删除失败，请稍后重试。' });
        }

        if (current && get().saveState.status === 'dirty') scheduleSave();
        return false;
      }

      if (get().record?.id === id) {
        clearSaveTimer();
        editRevision += 1;
        writeCurrentPlanId(null);
        set({
          record: null,
          selectedNodeId: null,
          saveState: { status: 'idle' },
          editError: null,
          regeneratingNodeId: null,
          regenerateError: null,
          notice: null,
        });
      }

      await get().refreshHistory();
      return true;
    },

    clearHistory: async () => {
      abortRegeneration();
      set({ regeneratingNodeId: null, regenerateError: null });
      const wasGenerating = get().generation.phase === 'generating';
      if (wasGenerating) get().cancel();
      if (get().saveState.status === 'saving') await saveChain;

      const hadPendingEdits = get().saveState.status === 'dirty';
      clearSaveTimer();

      try {
        await clearPlansRequest();
      } catch {
        set({ historyError: '清空失败，请稍后重试。' });
        if (hadPendingEdits) scheduleSave();
        return false;
      }

      editRevision += 1;
      writeCurrentPlanId(null);
      set({
        record: null,
        selectedNodeId: null,
        saveState: { status: 'idle' },
        editError: null,
        regeneratingNodeId: null,
        regenerateError: null,
        notice: wasGenerating ? '已取消生成。' : null,
      });

      await get().refreshHistory();
      return true;
    },

    renamePlan: (title) => {
      if (get().regeneratingNodeId !== null) return;
      const record = get().record;
      if (!record) return;

      const trimmed = title.trim();
      if (!trimmed || trimmed === record.title) return;

      editRevision += 1;
      set((state) => ({
        record: {
          ...record,
          title: trimmed,
          plan: { ...record.plan, title: trimmed },
        },
        saveState: { status: 'dirty' },
        editError: null,
        history: state.history.map((item) =>
          item.id === record.id ? { ...item, title: trimmed } : item,
        ),
      }));
      scheduleSave();
    },

    selectNode: (id) => {
      if (get().selectedNodeId === id) return;
      set({ selectedNodeId: id, editError: null, regenerateError: null });
    },

    updateNode: (id, patch) => {
      if (get().regeneratingNodeId !== null) return;
      const record = get().record;
      if (!record) return;

      const nodes = updatePlanNode(record.plan.nodes, id, patch);
      if (nodes === record.plan.nodes) return;

      const plan = { ...record.plan, nodes };

      if ('deps' in patch) {
        const dependencyIssue = validatePlan(plan).find(
          (issue) => issue.path === 'deps' || issue.path.includes('.deps'),
        );

        if (dependencyIssue) {
          set({ editError: `依赖不合法：${dependencyIssue.message}` });
          return;
        }
      }

      editRevision += 1;
      set({
        record: { ...record, plan },
        saveState: { status: 'dirty' },
        editError: null,
      });
      scheduleSave();
    },

    addChildNode: (parentId) => {
      if (get().regeneratingNodeId !== null) return null;
      const record = get().record;
      if (!record) return null;

      const child = createLeafDraft();
      const nodes = insertChildNode(record.plan.nodes, parentId, child);

      if (nodes === record.plan.nodes) {
        set({
          editError: `只能在阶段或分组下新增叶子任务，且最多 ${MAX_TASK_DEPTH} 层。`,
        });
        return null;
      }

      editRevision += 1;
      set({
        record: { ...record, plan: { ...record.plan, nodes } },
        selectedNodeId: child.id,
        saveState: { status: 'dirty' },
        editError: null,
        notice: '已新增叶子任务，请补充标题和验收标准。',
      });
      scheduleSave();
      return child.id;
    },

    deleteNode: (id) => {
      if (get().regeneratingNodeId !== null) return null;
      const record = get().record;
      if (!record) return null;

      const result = removePlanNode(record.plan.nodes, id);
      if (result.removedNodeIds.length === 0) return null;

      if (result.nodes.length === 0) {
        set({ editError: '计划至少需要一个阶段，无法删除最后一个阶段。' });
        return null;
      }

      editRevision += 1;
      set({
        record: {
          ...record,
          plan: { ...record.plan, nodes: result.nodes },
        },
        selectedNodeId: result.removedNodeIds.includes(get().selectedNodeId ?? '')
          ? null
          : get().selectedNodeId,
        saveState: { status: 'dirty' },
        editError: null,
        notice:
          result.clearedDependencies > 0
            ? `已删除 ${result.removedNodeIds.length} 个节点，并移除 ${result.clearedDependencies} 条依赖。`
            : `已删除 ${result.removedNodeIds.length} 个节点。`,
      });
      scheduleSave();

      return {
        removedNodes: result.removedNodeIds.length,
        clearedDependencies: result.clearedDependencies,
      };
    },

    moveNode: (draggedId, target) => {
      if (get().regeneratingNodeId !== null) return false;
      const record = get().record;
      if (!record) return false;

      const result = movePlanNode(record.plan.nodes, draggedId, target);
      if (!result.moved) {
        if (result.reason) set({ notice: result.reason, editError: null });
        return false;
      }

      editRevision += 1;
      set({
        record: { ...record, plan: { ...record.plan, nodes: result.nodes } },
        saveState: { status: 'dirty' },
        editError: null,
        notice: null,
      });
      scheduleSave();
      return true;
    },

    regenerateNode: async (nodeId) => {
      const record = get().record;
      if (!record || get().regeneratingNodeId) return;

      if (get().generation.phase === 'generating') {
        set({ regenerateError: '请等待当前生成完成后再重新生成。' });
        return;
      }

      set({
        regeneratingNodeId: nodeId,
        regenerateError: null,
        editError: null,
        notice: null,
      });

      await get().saveNow();

      if (get().saveState.status !== 'idle') {
        set({
          regeneratingNodeId: null,
          regenerateError: '请先解决当前未保存的修改，再重新生成。',
        });
        return;
      }

      const controller = new AbortController();
      regenerateController = controller;

      try {
        const result = await regenerateLeafRequest(
          record.id,
          nodeId,
          controller.signal,
        );

        if (get().record?.id !== record.id) return;

        editRevision += 1;
        set((state) => ({
          record: result.record,
          saveState: { status: 'idle' },
          editError: null,
          regenerateError: null,
          history: upsertHistory(state.history, result.record),
          notice: result.warning ?? '已重新生成叶子任务。',
        }));
      } catch (error) {
        if (error instanceof ApiError && error.code === 'CANCELLED') return;
        if (get().record?.id !== record.id) return;
        set({ regenerateError: describeRegenerationFailure(error) });
      } finally {
        if (regenerateController === controller) regenerateController = null;
        if (get().regeneratingNodeId === nodeId) {
          set({ regeneratingNodeId: null });
        }
      }
    },

    saveNow: async (options = {}) => {
      clearSaveTimer();

      if (options.keepalive && saving) {
        flushKeepalive();
        return;
      }

      if (get().saveState.status === 'saving') {
        await saveChain;
      }

      const status = get().saveState.status;
      if (status !== 'dirty' && status !== 'error' && status !== 'invalid') {
        return;
      }

      await requestSave(options.keepalive ?? false);
    },

    retrySave: async () => {
      clearSaveTimer();
      await requestSave();
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
  };
});
