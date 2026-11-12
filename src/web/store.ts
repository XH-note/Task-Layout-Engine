import { create } from 'zustand';

import { readStorageValue, writeStorageValue } from './browser-storage';

const DRAFT_KEY = 'task-layout:source-draft';

function readDraft(): string {
  return readStorageValue('session', DRAFT_KEY) ?? '';
}

function writeDraft(source: string) {
  writeStorageValue('session', DRAFT_KEY, source.length === 0 ? null : source);
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
