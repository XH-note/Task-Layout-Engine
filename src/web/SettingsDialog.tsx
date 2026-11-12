import { useEffect, useRef, useState } from 'react';

import {
  CAPABILITY_LABELS,
  MODEL_PRESETS,
  parseExtraBody,
  type PublicSettings,
  type SettingsDraft,
  type SettingsError,
  type TestConnectionResult,
} from '../shared/settings';
import { ApiError, getSettings, saveSettings, testConnection } from './api';

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface FormState {
  baseUrl: string;
  model: string;
  extraBody: string;
  apiKey: string;
  persistKey: boolean;
}

const EMPTY_FORM: FormState = {
  baseUrl: '',
  model: '',
  extraBody: '{}',
  apiKey: '',
  persistKey: true,
};

function toSettingsError(error: unknown): SettingsError {
  if (error instanceof ApiError) {
    return {
      code: error.code,
      message: error.message,
      field: error.field,
      line: error.line,
      column: error.column,
    };
  }

  return {
    code: 'UNKNOWN',
    message: error instanceof Error ? error.message : '操作失败，请重试。',
  };
}

export default function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [savedSettings, setSavedSettings] = useState<PublicSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<SettingsError | null>(null);
  const [notice, setNotice] = useState('');
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const modelInputRef = useRef<HTMLInputElement>(null);
  const feedbackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setNotice('');
    setTestResult(null);

    getSettings()
      .then((settings) => {
        if (cancelled) return;

        setSavedSettings(settings);
        setForm({
          baseUrl: settings.baseUrl,
          model: settings.model,
          extraBody: JSON.stringify(settings.extraBody, null, 2),
          apiKey: '',
          persistKey: settings.keySource !== 'session',
        });
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(toSettingsError(loadError));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open || (!error && !notice && !testResult)) return;
    feedbackRef.current?.scrollIntoView({ block: 'nearest' });
  }, [open, error, notice, testResult]);

  if (!open) return null;

  const presetValue = MODEL_PRESETS.some((preset) => preset.value === form.model)
    ? form.model
    : 'custom';

  const updateForm = (patch: Partial<FormState>) => {
    setForm((current) => ({ ...current, ...patch }));
    setNotice('');
    setError(null);
  };

  const buildDraft = (): SettingsDraft => ({
    baseUrl: form.baseUrl,
    model: form.model,
    extraBody: form.extraBody,
    ...(form.apiKey.trim() ? { apiKey: form.apiKey.trim() } : {}),
    persistKey: form.persistKey,
  });

  const validateForm = (): boolean => {
    const parsed = parseExtraBody(form.extraBody);
    if (!parsed.ok) {
      setError(parsed.error);
      return false;
    }

    return true;
  };

  const handleSave = async () => {
    if (!validateForm()) return;

    setSaving(true);
    setError(null);
    setNotice('');
    setTestResult(null);

    try {
      const saved = await saveSettings(buildDraft());
      setSavedSettings(saved);
      setForm({
        baseUrl: saved.baseUrl,
        model: saved.model,
        extraBody: JSON.stringify(saved.extraBody, null, 2),
        apiKey: '',
        persistKey: saved.keySource !== 'session',
      });
      setNotice('设置已保存。');
    } catch (saveError) {
      setError(toSettingsError(saveError));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    if (!validateForm()) return;

    setTesting(true);
    setError(null);
    setNotice('');
    setTestResult(null);

    try {
      const result = await testConnection(buildDraft());
      setTestResult(result);
    } catch (testError) {
      setError(toSettingsError(testError));
    } finally {
      setTesting(false);
    }
  };

  const busy = loading || saving || testing;

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="dialog-header">
          <div>
            <p className="eyebrow">模型接入</p>
            <h2 id="settings-title">设置</h2>
            <p className="dialog-subtitle">配置 OpenAI 兼容接口；key 只保存在这台机器。</p>
          </div>
          <button className="dialog-close" type="button" onClick={onClose} aria-label="关闭设置">
            ×
          </button>
        </header>

        <div className="settings-body">
          {loading ? (
            <p className="settings-loading">正在读取设置…</p>
          ) : (
            <>
              <div className="field">
                <label className="field-label" htmlFor="settings-base-url">
                  Base URL
                </label>
                <input
                  id="settings-base-url"
                  className="text-input"
                  type="url"
                  value={form.baseUrl}
                  onChange={(event) => updateForm({ baseUrl: event.target.value })}
                  placeholder="https://api.deepseek.com/v1"
                  spellCheck={false}
                  autoFocus
                />
                <p className="field-hint">填写完整地址，包含 /v1；不会自动补全。</p>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="settings-api-key">
                  API key
                </label>
                <input
                  id="settings-api-key"
                  className="text-input"
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => updateForm({ apiKey: event.target.value })}
                  placeholder={
                    savedSettings?.hasKey
                      ? `已保存 ${savedSettings.keyMask}，留空保持不变`
                      : 'sk-...'
                  }
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="field-hint">
                  {savedSettings?.hasKey
                    ? `当前 key：${savedSettings.keyMask}。保存后只显示掩码，不会回传完整 key。`
                    : '还没有保存 key。测试连接时也可以直接填入临时 key。'}
                </p>
              </div>

              <fieldset className="field radio-field">
                <legend className="field-label">API key 保存方式</legend>
                <label className={`radio-option ${form.persistKey ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="key-persistence"
                    checked={form.persistKey}
                    onChange={() => updateForm({ persistKey: true })}
                  />
                  <span className="radio-copy">
                    <strong>保存到本机</strong>
                    <span>明文写入 %APPDATA%\task-layout\settings.json，重启后仍可用。</span>
                  </span>
                </label>
                <label className={`radio-option ${form.persistKey ? '' : 'selected'}`}>
                  <input
                    type="radio"
                    name="key-persistence"
                    checked={!form.persistKey}
                    onChange={() => updateForm({ persistKey: false })}
                  />
                  <span className="radio-copy">
                    <strong>仅本次会话</strong>
                    <span>只存在服务进程内存里，重启后需要重新输入。</span>
                  </span>
                </label>
              </fieldset>

              <div className="field">
                <label className="field-label" htmlFor="settings-model">
                  模型名
                </label>
                <div className="model-row">
                  <select
                    className="select-input"
                    aria-label="模型预设"
                    value={presetValue}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (next === 'custom') {
                        modelInputRef.current?.focus();
                        return;
                      }
                      updateForm({ model: next });
                    }}
                  >
                    <option value="custom">自定义</option>
                    {MODEL_PRESETS.map((preset) => (
                      <option key={preset.value} value={preset.value}>
                        {preset.label}
                      </option>
                    ))}
                  </select>
                  <input
                    id="settings-model"
                    ref={modelInputRef}
                    className="text-input"
                    type="text"
                    value={form.model}
                    onChange={(event) => updateForm({ model: event.target.value })}
                    placeholder="deepseek-flash"
                    spellCheck={false}
                  />
                </div>
                <p className="field-hint">可输入任意 OpenAI 兼容模型名。</p>
              </div>

              <div className="field">
                <label className="field-label" htmlFor="settings-extra-body">
                  额外请求体（可选）
                </label>
                <textarea
                  id="settings-extra-body"
                  className="json-input"
                  value={form.extraBody}
                  onChange={(event) => updateForm({ extraBody: event.target.value })}
                  placeholder='{"thinking":{"type":"enabled"}}'
                  spellCheck={false}
                  rows={4}
                />
                <p className="field-hint">
                  合法 JSON 对象，会合并进请求体。不是合法 JSON 时会拒绝保存并指出位置。
                </p>
              </div>

              {(error || notice || testResult) && (
                <div className="settings-feedback" ref={feedbackRef}>
                  {error && (
                    <div className="form-alert" role="alert">
                      {error.message}
                    </div>
                  )}

                  {notice && (
                    <div className="form-notice" role="status">
                      {notice}
                    </div>
                  )}

                  {testResult && (
                    <div
                      className={testResult.ok ? 'test-result success' : 'test-result failure'}
                      role="status"
                    >
                      <strong>{testResult.ok ? '连接成功' : '连接失败'}</strong>
                      <span>
                        {' '}
                        · {CAPABILITY_LABELS[testResult.capability]}（{testResult.capability}） ·{' '}
                        {testResult.latencyMs} ms
                      </span>
                      {!testResult.ok && <p>{testResult.message}</p>}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <footer className="dialog-actions">
          <button className="secondary-button" type="button" onClick={handleTest} disabled={busy}>
            {testing ? '测试中…' : '测试连接'}
          </button>
          <span className="dialog-spacer" />
          <button className="ghost-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="button" onClick={handleSave} disabled={busy}>
            {saving ? '保存中…' : '保存设置'}
          </button>
        </footer>
      </section>
    </div>
  );
}
