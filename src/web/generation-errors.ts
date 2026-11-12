export interface GenerationFailure {
  code: string;
  title: string;
  description: string;
  hint: string;
  retryable: boolean;
  autoRetried: boolean;
  detail: string | null;
  action?: 'settings';
}

export interface GenerationFailureInput {
  code?: string;
  message?: string;
  detail?: unknown;
  retryable?: boolean;
}

interface FailureCopy {
  title: string;
  description: string;
  hint: string;
  retryable: boolean;
  autoRetried?: boolean;
  action?: 'settings';
}

const FAILURES: Record<string, FailureCopy> = {
  NETWORK_ERROR: {
    title: '无法连接本地服务',
    description: '本地应用服务没有响应。',
    hint: '请确认应用服务正在运行，然后重试。',
    retryable: true,
  },
  PROVIDER_NETWORK: {
    title: '网络连接失败',
    description: '无法连接模型服务。',
    hint: '检查网络或 base URL 后重试；网络错误已自动重试一次。',
    retryable: true,
    autoRetried: true,
  },
  PROVIDER_AUTH: {
    title: '密钥无效或无权限',
    description: '模型服务拒绝了认证请求。',
    hint: '前往设置检查 API Key 或账号权限，然后重试。',
    retryable: false,
    action: 'settings',
  },
  PROVIDER_RATE_LIMIT: {
    title: '请求过于频繁',
    description: '模型服务暂时限流。',
    hint: '稍等片刻再重试；限流错误已自动重试一次。',
    retryable: true,
    autoRetried: true,
  },
  PROVIDER_TIMEOUT: {
    title: '生成超时',
    description: '模型服务在 120 秒内没有返回结果。',
    hint: '可以重试，或更换响应更快的模型。',
    retryable: true,
  },
  PROVIDER_BAD_REQUEST: {
    title: '请求参数错误',
    description: '模型服务拒绝了请求参数。',
    hint: '检查模型名称、base URL 或额外请求体。',
    retryable: false,
  },
  PROVIDER_SERVER: {
    title: '模型服务暂时不可用',
    description: '模型服务返回了服务器错误。',
    hint: '稍后重试；服务器错误已自动重试一次。',
    retryable: true,
    autoRetried: true,
  },
  PROVIDER_BAD_RESPONSE: {
    title: '模型响应异常',
    description: '模型服务返回了无法解析的响应。',
    hint: '可以重试，或检查 base URL 是否完整。',
    retryable: true,
  },
  PROVIDER_ERROR: {
    title: '模型服务异常',
    description: '模型服务返回了异常状态。',
    hint: '稍后重试，或检查 provider 配置。',
    retryable: true,
  },
  OUTPUT_TRUNCATED: {
    title: '输出被截断',
    description: '模型输出达到长度上限，任务计划书不完整。',
    hint: '缩短原文，或更换上下文更长的模型后重试。',
    retryable: true,
  },
  OUTPUT_INVALID: {
    title: '模型输出格式异常',
    description: '模型两次输出都没有形成合法的任务计划书 JSON。',
    hint: '可以重试，或更换模型。',
    retryable: true,
  },
  INTEGRITY: {
    title: '计划结构不完整',
    description: '模型输出未通过任务计划书结构校验。',
    hint: '可以重试，或更换模型。',
    retryable: true,
  },
  BUSY: {
    title: '正在生成',
    description: '已有生成任务正在进行。',
    hint: '等待当前任务结束，或稍后重试。',
    retryable: true,
  },
  STORAGE: {
    title: '保存失败',
    description: '任务计划书无法写入本机数据文件。',
    hint: '检查磁盘空间和文件权限后重试。',
    retryable: true,
  },
  INVALID_INPUT: {
    title: '请求无效',
    description: '输入未通过服务端校验。',
    hint: '修改原文后重试。',
    retryable: false,
  },
  INTERNAL: {
    title: '服务器内部错误',
    description: '本地服务处理请求时发生了异常。',
    hint: '稍后重试；如果持续出现，请重启应用服务。',
    retryable: true,
  },
};

function readDetail(detail: unknown): string | null {
  if (typeof detail === 'string') {
    const text = detail.trim();
    return text === '' ? null : text.slice(0, 1_000);
  }

  if (Array.isArray(detail)) {
    const lines = detail
      .slice(0, 20)
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item !== 'object' || item === null) return '';
        const record = item as { path?: unknown; message?: unknown };
        const path = typeof record.path === 'string' ? record.path : '';
        const message = typeof record.message === 'string' ? record.message : '';
        return path && message ? `${path}：${message}` : message;
      })
      .filter((line) => line !== '');
    return lines.length > 0 ? lines.join('\n').slice(0, 1_000) : null;
  }

  if (typeof detail === 'object' && detail !== null) {
    try {
      const text = JSON.stringify(detail).slice(0, 1_000);
      return text === '{}' ? null : text;
    } catch {
      return null;
    }
  }

  return null;
}

export function mapGenerationFailure(
  input: GenerationFailureInput | null,
): GenerationFailure {
  const code = input?.code ?? 'UNKNOWN';
  const fallback = FAILURES[code] ?? {
    title: '生成失败',
    description: input?.message ?? '生成任务没有完成。',
    hint: '请稍后重试。',
    retryable: input?.retryable ?? true,
  };

  return {
    code,
    title: fallback.title,
    description:
      (code === 'INVALID_INPUT' || code === 'OUTPUT_TRUNCATED') && input?.message
        ? input.message
        : fallback.description,
    hint: fallback.hint,
    retryable: fallback.retryable,
    autoRetried: fallback.autoRetried ?? false,
    detail: readDetail(input?.detail),
    ...(fallback.action ? { action: fallback.action } : {}),
  };
}
