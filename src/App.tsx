import {
  Activity,
  AlertCircle,
  Download,
  FileAudio,
  Loader2,
  Play,
  RefreshCcw,
  Square,
  Wand2
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";

type StatusResponse = {
  ok: boolean;
  model: string;
  apiKeyConfigured: boolean;
  maxAudioBytes: number;
  allowedMimeTypes: string[];
};

type DebugResponse = {
  audioDataUrl: string;
  fileName: string;
  elapsedMs: number;
  request: unknown;
  response: unknown;
};

type ApiError = {
  error: string;
  status?: number;
  elapsedMs?: number;
  details?: unknown;
  request?: unknown;
};

const initialText = "今天我们完成了 MiMo 音色复刻调试链路，现在用这段声音检查相似度、节奏和情绪表现。";
const initialInstruction = "自然、清晰、略带播客讲述感，语速中等，语气友好但不过分夸张。";
const maxAudioBytes = Math.floor(7.5 * 1024 * 1024);

export default function App() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [voiceFile, setVoiceFile] = useState<File | null>(null);
  const [text, setText] = useState(initialText);
  const [instruction, setInstruction] = useState(initialInstruction);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [result, setResult] = useState<DebugResponse | null>(null);
  const [apiError, setApiError] = useState<ApiError | null>(null);
  const [showDebug, setShowDebug] = useState(true);
  const [localPreviewUrl, setLocalPreviewUrl] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const outputAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    void loadStatus();
  }, []);

  useEffect(() => {
    if (!voiceFile) {
      setLocalPreviewUrl(null);
      return;
    }

    const url = URL.createObjectURL(voiceFile);
    setLocalPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [voiceFile]);

  const canSubmit = useMemo(() => {
    return Boolean(voiceFile && text.trim() && !isSubmitting);
  }, [voiceFile, text, isSubmitting]);

  async function loadStatus() {
    try {
      setStatusError(null);
      const response = await fetch("/api/status");
      if (!response.ok) {
        throw new Error(`状态检查失败：HTTP ${response.status}`);
      }
      setStatus((await response.json()) as StatusResponse);
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "状态检查失败");
    }
  }

  function handleFileChange(file: File | null) {
    setResult(null);
    setApiError(null);

    if (!file) {
      setVoiceFile(null);
      return;
    }

    const allowedTypes = new Set([
      "audio/mpeg",
      "audio/mp3",
      "audio/mp4",
      "audio/m4a",
      "audio/wav",
      "audio/x-wav",
      "audio/wave",
      "video/mp4"
    ]);
    if (!allowedTypes.has(file.type)) {
      setApiError({ error: "请上传 mp3、m4a/mp4 音频或 wav 格式的参考音频。" });
      setVoiceFile(null);
      return;
    }

    if (file.size > maxAudioBytes) {
      setApiError({ error: `参考音频不能超过 ${formatBytes(maxAudioBytes)}。` });
      setVoiceFile(null);
      return;
    }

    setVoiceFile(file);
  }

  async function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();

    if (!voiceFile || !text.trim()) {
      setApiError({ error: "请先上传参考音频并填写要合成的文本。" });
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsSubmitting(true);
    setResult(null);
    setApiError(null);

    try {
      const formData = new FormData();
      formData.append("voice", voiceFile);
      formData.append("text", text.trim());
      formData.append("instruction", instruction.trim());
      formData.append("format", "wav");

      const response = await fetch("/api/tts/voiceclone", {
        method: "POST",
        body: formData,
        signal: controller.signal
      });

      const payload = (await response.json()) as DebugResponse | ApiError;
      if (!response.ok) {
        setApiError(payload as ApiError);
        return;
      }

      setResult(payload as DebugResponse);
      window.setTimeout(() => void outputAudioRef.current?.play(), 100);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setApiError({ error: "请求已取消。" });
      } else {
        setApiError({ error: error instanceof Error ? error.message : "请求失败。" });
      }
    } finally {
      setIsSubmitting(false);
      abortRef.current = null;
    }
  }

  function cancelRequest() {
    abortRef.current?.abort();
  }

  function downloadResult() {
    if (!result) {
      return;
    }

    const link = document.createElement("a");
    link.href = result.audioDataUrl;
    link.download = result.fileName;
    link.click();
  }

  const requestPreview = {
    model: "mimo-v2.5-tts-voiceclone",
    messages: [
      { role: "user", content: instruction },
      { role: "assistant", content: text }
    ],
    audio: {
      format: "wav",
      voice: voiceFile ? `data:${voiceFile.type};base64,<${formatBytes(voiceFile.size)} reference audio omitted>` : "<upload an mp3 or wav file>"
    }
  };

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <p className="eyebrow">MiMo V2.5 TTS VoiceClone</p>
          <h1>音色复刻语音合成调试台</h1>
        </div>
        <StatusBadge status={status} error={statusError} onRefresh={loadStatus} />
      </section>

      <form className="workspace" onSubmit={submit}>
        <section className="panel controls-panel">
          <div className="section-title">
            <FileAudio size={18} />
            <span>参考音频</span>
          </div>

          <label className="dropzone">
              <input
              accept="audio/mpeg,audio/mp3,audio/mp4,audio/m4a,audio/wav,audio/x-wav,video/mp4,.mp3,.m4a,.mp4,.wav"
              type="file"
              onChange={(event) => handleFileChange(event.target.files?.[0] ?? null)}
            />
            <span>{voiceFile ? voiceFile.name : "选择 mp3、m4a/mp4 或 wav 文件"}</span>
            <small>
              {voiceFile ? `${voiceFile.type || "unknown"} · ${formatBytes(voiceFile.size)}` : `最大 ${formatBytes(maxAudioBytes)}，支持改后缀的 M4A/MP4`}
            </small>
          </label>

          {localPreviewUrl ? (
            <audio className="audio-control" src={localPreviewUrl} controls />
          ) : null}

          <label className="field">
            <span>风格 / 导演指令</span>
            <textarea
              value={instruction}
              onChange={(event) => setInstruction(event.target.value)}
              rows={5}
              placeholder="例如：自然、温柔、播客感，语速中等，句尾稍微上扬。"
            />
          </label>

          <label className="field">
            <span>要合成的文本</span>
            <textarea
              value={text}
              onChange={(event) => setText(event.target.value)}
              rows={7}
              required
              placeholder="这里的文本会写入 assistant.content，并出现在最终音频中。"
            />
          </label>

          <div className="actions">
            <button className="primary" type="submit" disabled={!canSubmit}>
              {isSubmitting ? <Loader2 className="spin" size={18} /> : <Wand2 size={18} />}
              <span>{result ? "重新生成" : "生成语音"}</span>
            </button>
            <button type="button" onClick={cancelRequest} disabled={!isSubmitting}>
              <Square size={17} />
              <span>取消</span>
            </button>
          </div>
        </section>

        <section className="panel result-panel">
          <div className="section-title">
            <Activity size={18} />
            <span>结果</span>
          </div>

          {apiError ? (
            <div className="notice error">
              <AlertCircle size={18} />
              <div>
                <strong>{apiError.error}</strong>
                {apiError.status ? <p>HTTP {apiError.status}</p> : null}
                {apiError.elapsedMs ? <p>耗时 {apiError.elapsedMs} ms</p> : null}
              </div>
            </div>
          ) : null}

          {result ? (
            <div className="player-card">
              <audio ref={outputAudioRef} src={result.audioDataUrl} controls />
              <div className="result-meta">
                <span>耗时 {result.elapsedMs} ms</span>
                <span>{result.fileName}</span>
              </div>
              <div className="actions compact">
                <button type="button" onClick={() => void outputAudioRef.current?.play()}>
                  <Play size={17} />
                  <span>播放</span>
                </button>
                <button type="button" onClick={downloadResult}>
                  <Download size={17} />
                  <span>下载</span>
                </button>
                <button type="button" onClick={() => void submit()}>
                  <RefreshCcw size={17} />
                  <span>重新生成</span>
                </button>
              </div>
            </div>
          ) : (
            <div className="empty-state">
              {isSubmitting ? "正在请求 MiMo API，生成完成后会在这里播放。" : "上传参考音频并提交后，这里会显示生成结果。"}
            </div>
          )}

          <label className="debug-toggle">
            <input type="checkbox" checked={showDebug} onChange={(event) => setShowDebug(event.target.checked)} />
            <span>显示调试 JSON</span>
          </label>

          {showDebug ? (
            <div className="debug-grid">
              <DebugBlock title="请求预览" value={result?.request ?? apiError?.request ?? requestPreview} />
              <DebugBlock title={result ? "响应摘要" : "错误详情"} value={result?.response ?? apiError?.details ?? { status }} />
            </div>
          ) : null}
        </section>
      </form>
    </main>
  );
}

function StatusBadge({ status, error, onRefresh }: { status: StatusResponse | null; error: string | null; onRefresh: () => void }) {
  const label = error ? "代理不可用" : status?.apiKeyConfigured ? "API Key 已配置" : "API Key 未配置";
  const tone = error ? "bad" : status?.apiKeyConfigured ? "good" : "warn";

  return (
    <button className={`status-badge ${tone}`} type="button" onClick={onRefresh} title="刷新代理状态">
      <Activity size={17} />
      <span>{label}</span>
    </button>
  );
}

function DebugBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="debug-block">
      <h2>{title}</h2>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
