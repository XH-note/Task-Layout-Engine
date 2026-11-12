import { create } from 'zustand';

const DRAFT_KEY = 'task-layout:source-draft';

function readDraft(): string {
  if (typeof window === 'undefined') return '';

  try {
    return window.sessionStorage.getItem(DRAFT_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(source: string) {
  if (typeof window === 'undefined') return;

  try {
    if (source.length === 0) {
      window.sessionStorage.removeItem(DRAFT_KEY);
    } else {
      window.sessionStorage.setItem(DRAFT_KEY, source);
    }
  } catch {
    // 私密模式或存储被禁用时，草稿只保留在当前页面状态里。
  }
}

type WorkbenchState = {
  source: string;
  setSource: (source: string) => void;
  clearSource: () => void;
};

export const useWorkbenchStore = create<WorkbenchState>((set) => ({
  source: readDraft(),
  setSource: (source) => {
    set({ source });
    writeDraft(source);
  },
  clearSource: () => {
    set({ source: '' });
    writeDraft('');
  },
}));
