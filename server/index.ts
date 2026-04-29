import cors from "cors";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import multer from "multer";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 3001);
const maxAudioBytes = Math.floor(7.5 * 1024 * 1024);
const allowedMimeTypes = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "video/mp4"
]);
const mimoEndpoint = "https://api.xiaomimimo.com/v1/chat/completions";
const dataDir = path.resolve(process.cwd(), "data");
const workspaceFilePath = path.join(dataDir, "workspaces.json");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: maxAudioBytes,
    files: 1
  }
});

type MimoPayload = {
  model: "mimo-v2.5-tts-voiceclone";
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  audio: {
    format: "wav";
    voice: string;
  };
};

type MimoVoiceDesignPayload = {
  model: "mimo-v2.5-tts-voicedesign";
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  audio: {
    format: "wav";
  };
};

type MimoChatPayload = {
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  top_p?: number;
};

type MimoResponse = {
  choices?: Array<{
    message?: {
      content?: string;
      audio?: {
        data?: string;
      };
    };
  }>;
};

type VoiceStyleOptimizePayload = {
  style: string;
};

type VoiceDesignOptimizePayload = {
  voiceDescription: string;
};

type VoiceDesignPayload = {
  voiceDescription: string;
  text: string;
  instruction?: string;
  format?: string;
};

type SmartWorkspacePlan = {
  workspaceName?: unknown;
  segments?: unknown;
};

type SmartWorkspaceSegment = {
  index: number;
  title: string;
  directorText: string;
};

type StoredWorkspace = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  nodes: unknown[];
  edges: unknown[];
  stashItems: unknown[];
  viewport?: unknown;
};

type WorkspaceStore = {
  activeWorkspaceId: string | null;
  workspaces: StoredWorkspace[];
};

app.use(cors());
// 画板会持久化参考音频和生成产物的 data URL，本地工作站需要更高的 JSON 限制。
app.use(express.json({ limit: "80mb" }));

app.get("/api/status", (_req, res) => {
  res.json({
    ok: true,
    model: "mimo-v2.5-tts-voiceclone",
    apiKeyConfigured: Boolean(process.env.MIMO_API_KEY),
    maxAudioBytes,
    allowedMimeTypes: Array.from(allowedMimeTypes)
  });
});

app.post("/api/voice-style/optimize", async (req: Request<unknown, unknown, VoiceStyleOptimizePayload>, res, next) => {
  const startedAt = Date.now();

  try {
    const apiKey = process.env.MIMO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const style = String(req.body?.style || "").trim();
    if (!style) {
      return res.status(400).json({ error: "Voice style text is required." });
    }

    const payload = {
      model: "mimo-v2-flash",
      messages: [
        {
          role: "system",
          content:
            "你是专业的中文有声内容导演和 TTS 语音风格提示词编辑。你的任务是把用户粗略的语音风格描述优化为更适合语音克隆合成模型理解的导演文本。只输出优化后的提示词，不要解释，不要使用 Markdown。"
        },
        {
          role: "user",
          content: [
            "请优化下面的语音风格描述，使其更具体、可执行、适合语音克隆 TTS：",
            "",
            "要求：",
            "1. 保留用户原本想要的情绪和风格，不要改成另一个角色。",
            "2. 补充语速、停顿、重音、气息、音色质感、情绪层次和表达场景。",
            "3. 避免混响、EQ、压缩等后期制作词。",
            "4. 输出一段 80 到 160 字的中文导演文本。",
            "",
            `用户原文：${style}`
          ].join("\n")
        }
      ],
      temperature: 0.6
    };

    const upstreamResponse = await fetch(mimoEndpoint, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await upstreamResponse.text();
    const elapsedMs = Date.now() - startedAt;
    const parsed = parseJson(responseText);

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        error: "MiMo style optimization request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText
      });
    }

    const optimizedText = extractMessageContent(parsed);
    if (!optimizedText) {
      return res.status(502).json({
        error: "MiMo response did not include choices[0].message.content.",
        elapsedMs,
        details: parsed
      });
    }

    res.json({
      optimizedText: optimizedText.trim(),
      elapsedMs
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/voice-design/optimize", async (req: Request<unknown, unknown, VoiceDesignOptimizePayload>, res, next) => {
  const startedAt = Date.now();

  try {
    const apiKey = process.env.MIMO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const voiceDescription = String(req.body?.voiceDescription || "").trim();
    if (!voiceDescription) {
      return res.status(400).json({ error: "Voice design description is required." });
    }

    const payload: MimoChatPayload = {
      model: "mimo-v2.5-pro",
      messages: [
        {
          role: "system",
          content:
            "你是专业的 TTS 音色设计提示词编辑。你的任务是把用户粗略的音色描述润色为适合 mimo-v2.5-tts-voicedesign 模型的 voice design prompt。只输出润色后的音色描述，不要解释，不要使用 Markdown。"
        },
        {
          role: "user",
          content: [
            "请润色下面的音色描述，使其更适合用文本设计音色进行语音合成。",
            "",
            "要求：",
            "1. 输出 1 到 4 句中文，清晰描述核心音色特征，不要过长。",
            "2. 优先补全这些维度：性别与年龄、声音质感、情绪/语气、语速/节奏。",
            "3. 可适度加入角色身份、说话风格、使用场景或时代质感，但不要堆砌。",
            "4. 避免互相矛盾的要求，例如童稚声音和强烈 CEO 气场同时出现。",
            "5. 不要使用混响、回声、EQ、压缩、母带等后期制作或音频工程术语。",
            "6. 避免“普通、正常、外国”等缺少具体参考的模糊词。",
            "7. 保留用户原本想要的音色方向，不要改成完全不同的声音。",
            "",
            `用户原文：${voiceDescription}`
          ].join("\n")
        }
      ],
      temperature: 0.45,
      top_p: 0.9
    };

    const upstreamResponse = await fetch(mimoEndpoint, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await upstreamResponse.text();
    const elapsedMs = Date.now() - startedAt;
    const parsed = parseJson(responseText);

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        error: "MiMo voice design optimization request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText
      });
    }

    const optimizedText = extractMessageContent(parsed);
    if (!optimizedText) {
      return res.status(502).json({
        error: "MiMo response did not include choices[0].message.content.",
        elapsedMs,
        details: parsed
      });
    }

    res.json({
      optimizedText: optimizedText.trim(),
      elapsedMs
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspaces", async (_req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    res.json({
      activeWorkspaceId: store.activeWorkspaceId,
      workspaces: store.workspaces.map((workspace) => ({
        id: workspace.id,
        name: workspace.name,
        createdAt: workspace.createdAt,
        updatedAt: workspace.updatedAt,
        nodeCount: workspace.nodes.length,
        edgeCount: workspace.edges.length,
        stashCount: workspace.stashItems.length
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.get("/api/workspaces/:id", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const workspace = store.workspaces.find((item) => item.id === req.params.id);
    if (!workspace) {
      return res.status(404).json({ error: "Workspace not found." });
    }

    res.json(workspace);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const now = new Date().toISOString();
    const workspace: StoredWorkspace = {
      id: createId("board"),
      name: normalizeWorkspaceName(req.body?.name),
      createdAt: now,
      updatedAt: now,
      nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : [],
      edges: Array.isArray(req.body?.edges) ? req.body.edges : [],
      stashItems: Array.isArray(req.body?.stashItems) ? req.body.stashItems : [],
      viewport: req.body?.viewport
    };

    store.workspaces.unshift(workspace);
    store.activeWorkspaceId = workspace.id;
    await writeWorkspaceStore(store);
    res.status(201).json(workspace);
  } catch (error) {
    next(error);
  }
});

app.post("/api/workspaces/smart", upload.single("voice"), async (req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now();

  try {
    const sceneDescription = String(req.body?.sceneDescription || "").trim();
    const script = String(req.body?.script || "").trim();
    const scriptSegments = splitScriptSegments(script);

    if (!req.file) {
      return res.status(400).json({ error: "Reference audio is required." });
    }

    const voiceMime = resolveVoiceMimeType(req.file);
    if (!voiceMime) {
      return res.status(400).json({
        error: "Unsupported audio type. Please upload an mp3, m4a/mp4 audio, or wav file.",
        receivedMimeType: req.file.mimetype,
        fileName: req.file.originalname
      });
    }

    if (!sceneDescription) {
      return res.status(400).json({ error: "Scene description is required." });
    }

    if (scriptSegments.length === 0) {
      return res.status(400).json({ error: "Script must include at least one paragraph. Use ---- to separate paragraphs." });
    }

    const apiKey = process.env.MIMO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const payload: MimoChatPayload = {
      model: "mimo-v2.5-pro",
      messages: [
        {
          role: "system",
          content:
            "你是专业的中文有声内容导演和工作流策划助手。你只根据用户给出的整体场景描述和逐段台词，为每段生成短标题和适合语音克隆 TTS 的语音风格文本。语音风格文本主要描述整体氛围、情绪、角色状态和表达质感，不要写具体台词的停顿、重音或逐句朗读指令。必须输出严格 JSON，不要使用 Markdown，不要输出解释。"
        },
        {
          role: "user",
          content: buildSmartWorkspacePrompt(sceneDescription, scriptSegments)
        }
      ],
      temperature: 0.35,
      top_p: 0.9
    };

    const upstreamResponse = await fetch(mimoEndpoint, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await upstreamResponse.text();
    const elapsedMs = Date.now() - startedAt;
    const parsed = parseJson(responseText);

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        error: "MiMo smart workspace request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText
      });
    }

    const content = extractMessageContent(parsed);
    if (!content) {
      return res.status(502).json({
        error: "MiMo response did not include choices[0].message.content.",
        elapsedMs,
        details: parsed
      });
    }

    const plan = parseSmartWorkspacePlan(content);
    if (!plan) {
      return res.status(502).json({
        error: "MiMo response was not valid smart workspace JSON.",
        elapsedMs,
        details: content
      });
    }

    const segments = normalizeSmartWorkspaceSegments(plan, scriptSegments.length);
    if (!segments) {
      return res.status(502).json({
        error: "MiMo smart workspace segment count did not match the script paragraphs.",
        expected: scriptSegments.length,
        details: plan
      });
    }

    const store = await readWorkspaceStore();
    const workspace = createSmartWorkspace({
      workspaceName: normalizeWorkspaceName(plan.workspaceName || `智能画板 ${new Date().toLocaleString("zh-CN", { hour12: false })}`),
      sceneDescription,
      scriptSegments,
      segments,
      file: req.file,
      voiceMime
    });

    store.workspaces.unshift(workspace);
    store.activeWorkspaceId = workspace.id;
    await writeWorkspaceStore(store);
    res.status(201).json(workspace);
  } catch (error) {
    next(error);
  }
});

app.put("/api/workspaces/:id", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const index = store.workspaces.findIndex((item) => item.id === req.params.id);
    if (index === -1) {
      return res.status(404).json({ error: "Workspace not found." });
    }

    const current = store.workspaces[index];
    const updated: StoredWorkspace = {
      ...current,
      name: normalizeWorkspaceName(req.body?.name ?? current.name),
      updatedAt: new Date().toISOString(),
      nodes: Array.isArray(req.body?.nodes) ? req.body.nodes : current.nodes,
      edges: Array.isArray(req.body?.edges) ? req.body.edges : current.edges,
      stashItems: Array.isArray(req.body?.stashItems) ? req.body.stashItems : current.stashItems,
      viewport: req.body?.viewport ?? current.viewport
    };

    store.workspaces[index] = updated;
    store.activeWorkspaceId = updated.id;
    await writeWorkspaceStore(store);
    res.json(updated);
  } catch (error) {
    next(error);
  }
});

app.delete("/api/workspaces/:id", async (req, res, next) => {
  try {
    const store = await readWorkspaceStore();
    const nextWorkspaces = store.workspaces.filter((item) => item.id !== req.params.id);
    if (nextWorkspaces.length === store.workspaces.length) {
      return res.status(404).json({ error: "Workspace not found." });
    }

    store.workspaces = nextWorkspaces;
    store.activeWorkspaceId = store.activeWorkspaceId === req.params.id ? (nextWorkspaces[0]?.id ?? null) : store.activeWorkspaceId;
    await writeWorkspaceStore(store);
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.post("/api/tts/voicedesign", async (req: Request<unknown, unknown, VoiceDesignPayload>, res, next) => {
  const startedAt = Date.now();

  try {
    const apiKey = process.env.MIMO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const voiceDescription = String(req.body?.voiceDescription || "").trim();
    const text = String(req.body?.text || "").trim();
    const instruction = String(req.body?.instruction || "").trim();
    const outputFormat = String(req.body?.format || "wav").trim();

    if (outputFormat !== "wav") {
      return res.status(400).json({ error: "Only wav output is supported in this debugger." });
    }

    if (!voiceDescription) {
      return res.status(400).json({ error: "Voice design description is required." });
    }

    if (!text) {
      return res.status(400).json({ error: "Synthesis text is required." });
    }

    const payload: MimoVoiceDesignPayload = {
      model: "mimo-v2.5-tts-voicedesign",
      messages: [
        { role: "user", content: voiceDescription },
        { role: "assistant", content: text }
      ],
      audio: {
        format: "wav"
      }
    };

    const upstreamResponse = await fetch(mimoEndpoint, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await upstreamResponse.text();
    const elapsedMs = Date.now() - startedAt;
    const parsed = parseJson(responseText);

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        error: "MiMo voice design request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText,
        request: redactVoiceDesignPayload(payload)
      });
    }

    if (!parsed) {
      return res.status(502).json({
        error: "MiMo API returned a non-JSON response.",
        elapsedMs,
        details: responseText.slice(0, 1000),
        request: redactVoiceDesignPayload(payload)
      });
    }

    const audioData = extractAudioData(parsed);
    if (!audioData) {
      return res.status(502).json({
        error: "MiMo API response did not include choices[0].message.audio.data.",
        elapsedMs,
        details: parsed,
        request: redactVoiceDesignPayload(payload)
      });
    }

    res.json({
      audioDataUrl: `data:audio/wav;base64,${audioData}`,
      fileName: `mimo-voicedesign-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`,
      elapsedMs,
      request: redactVoiceDesignPayload(payload),
      response: {
        audioBytesApprox: Math.floor((audioData.length * 3) / 4),
        choiceCount: getChoiceCount(parsed)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.post("/api/tts/voiceclone", upload.single("voice"), async (req: Request, res: Response, next: NextFunction) => {
  const startedAt = Date.now();

  try {
    const apiKey = process.env.MIMO_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: "MIMO_API_KEY is not configured. Copy .env.example to .env and set your key."
      });
    }

    const text = String(req.body.text || "").trim();
    const instruction = String(req.body.instruction || "").trim();
    const outputFormat = String(req.body.format || "wav").trim();

    if (outputFormat !== "wav") {
      return res.status(400).json({ error: "Only wav output is supported in this debugger." });
    }

    if (!text) {
      return res.status(400).json({ error: "Synthesis text is required." });
    }

    if (!req.file) {
      return res.status(400).json({ error: "A reference voice audio file is required." });
    }

    const voiceMime = resolveVoiceMimeType(req.file);
    if (!voiceMime) {
      return res.status(400).json({
        error: "Unsupported audio type. Please upload an mp3, m4a/mp4 audio, or wav file.",
        receivedMimeType: req.file.mimetype,
        fileName: req.file.originalname
      });
    }

    const audioBase64 = req.file.buffer.toString("base64");
    const payload: MimoPayload = {
      model: "mimo-v2.5-tts-voiceclone",
      messages: [
        { role: "user", content: instruction },
        { role: "assistant", content: text }
      ],
      audio: {
        format: "wav",
        voice: `data:${voiceMime};base64,${audioBase64}`
      }
    };

    const upstreamResponse = await fetch(mimoEndpoint, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await upstreamResponse.text();
    const elapsedMs = Date.now() - startedAt;
    const parsed = parseJson(responseText);

    if (!upstreamResponse.ok) {
      return res.status(upstreamResponse.status).json({
        error: "MiMo API request failed.",
        status: upstreamResponse.status,
        elapsedMs,
        details: parsed ?? responseText,
        request: redactPayload(payload, req.file)
      });
    }

    if (!parsed) {
      return res.status(502).json({
        error: "MiMo API returned a non-JSON response.",
        elapsedMs,
        details: responseText.slice(0, 1000),
        request: redactPayload(payload, req.file)
      });
    }

    const audioData = extractAudioData(parsed);
    if (!audioData) {
      return res.status(502).json({
        error: "MiMo API response did not include choices[0].message.audio.data.",
        elapsedMs,
        details: parsed,
        request: redactPayload(payload, req.file)
      });
    }

    res.json({
      audioDataUrl: `data:audio/wav;base64,${audioData}`,
      fileName: `mimo-voiceclone-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`,
      elapsedMs,
      request: redactPayload(payload, req.file),
      response: {
        audioBytesApprox: Math.floor((audioData.length * 3) / 4),
        choiceCount: getChoiceCount(parsed)
      }
    });
  } catch (error) {
    next(error);
  }
});

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: `Reference audio is too large. Maximum file size is ${formatBytes(maxAudioBytes)}.`
      });
    }

    return res.status(400).json({ error: error.message });
  }

  const message = error instanceof Error ? error.message : "Unexpected server error.";
  res.status(500).json({ error: message });
});

app.listen(port, () => {
  console.log(`MiMo voice clone proxy listening on http://localhost:${port}`);
});

function resolveVoiceMimeType(file: Express.Multer.File): "audio/mp3" | "audio/m4a" | "audio/wav" | null {
  const extension = file.originalname.split(".").pop()?.toLowerCase();
  const detected = detectAudioContainer(file.buffer);

  if (detected) {
    return detected;
  }

  if (extension === "mp3") {
    return "audio/mp3";
  }

  if (extension === "m4a" || extension === "mp4") {
    return "audio/m4a";
  }

  if (extension === "wav") {
    return "audio/wav";
  }

  if (file.mimetype === "audio/mpeg" || file.mimetype === "audio/mp3") {
    return "audio/mp3";
  }

  if (file.mimetype === "audio/mp4" || file.mimetype === "audio/m4a" || file.mimetype === "video/mp4") {
    return "audio/m4a";
  }

  if (file.mimetype === "audio/wav" || file.mimetype === "audio/x-wav" || file.mimetype === "audio/wave") {
    return "audio/wav";
  }

  return null;
}

function detectAudioContainer(buffer: Buffer): "audio/mp3" | "audio/m4a" | "audio/wav" | null {
  if (buffer.length < 12) {
    return null;
  }

  const first12 = buffer.subarray(0, 12).toString("latin1");
  if (first12.startsWith("RIFF") && first12.slice(8, 12) === "WAVE") {
    return "audio/wav";
  }

  if (first12.startsWith("ID3") || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return "audio/mp3";
  }

  // MP4/M4A files expose an ftyp box near the beginning. Renaming them to .mp3 does not change this.
  if (first12.slice(4, 8) === "ftyp") {
    return "audio/m4a";
  }

  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function extractAudioData(value: unknown): string | null {
  const response = value as MimoResponse;
  const data = response.choices?.[0]?.message?.audio?.data;
  return typeof data === "string" && data.length > 0 ? data : null;
}

function extractMessageContent(value: unknown): string | null {
  const response = value as MimoResponse;
  const content = response.choices?.[0]?.message?.content;
  return typeof content === "string" && content.length > 0 ? content : null;
}

function getChoiceCount(value: unknown): number {
  if (!value || typeof value !== "object" || !("choices" in value)) {
    return 0;
  }

  const choices = (value as { choices?: unknown }).choices;
  return Array.isArray(choices) ? choices.length : 0;
}

function redactPayload(payload: MimoPayload, file: Express.Multer.File) {
  return {
    ...payload,
    audio: {
      ...payload.audio,
      voice: `data:${resolveVoiceMimeType(file) ?? file.mimetype};base64,<${formatBytes(file.size)} reference audio omitted>`
    }
  };
}

function redactVoiceDesignPayload(payload: MimoVoiceDesignPayload) {
  return payload;
}

function formatBytes(bytes: number): string {
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed(1)} MB`;
}

function splitScriptSegments(script: string): string[] {
  return script
    .split(/\n?\s*----\s*\n?/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildSmartWorkspacePrompt(sceneDescription: string, scriptSegments: string[]): string {
  return [
    "请为下面的有声内容台词生成智能画板分段规划。",
    "",
    "整体场景描述：",
    sceneDescription,
    "",
    "分段台词：",
    scriptSegments.map((segment, index) => `第 ${index + 1} 段：\n${segment}`).join("\n\n"),
    "",
    "输出要求：",
    "1. 只输出严格 JSON，不要 Markdown，不要代码块，不要解释。",
    "2. 不要改写台词正文；你只负责生成 workspaceName、每段 title 和 directorText。",
    "3. segments 数量必须与分段台词数量完全一致，index 从 1 开始连续递增。",
    "4. 每段 directorText 必须主要描述整体氛围、情绪基调、角色心理状态、表达质感和表演意图。",
    "5. directorText 不要引用具体台词，不要写“在某句话后停顿”“重音放在某个词上”这类逐句朗读指令。",
    "6. directorText 可以描述整体语速和语气，但不要包含具体停顿位置、具体重音位置或逐字逐句的读法。",
    "7. title 应简短，适合用作画板节点名称。",
    "",
    "JSON 结构必须是：",
    '{"workspaceName":"string","segments":[{"index":1,"title":"string","directorText":"string"}]}'
  ].join("\n");
}

function parseSmartWorkspacePlan(content: string): SmartWorkspacePlan | null {
  const trimmed = content.trim();
  const candidates = [
    trimmed,
    trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, ""),
    trimmed.slice(trimmed.indexOf("{"), trimmed.lastIndexOf("}") + 1)
  ].filter((value) => value.trim().startsWith("{") && value.trim().endsWith("}"));

  for (const candidate of candidates) {
    const parsed = parseJson(candidate);
    if (parsed && typeof parsed === "object") {
      return parsed as SmartWorkspacePlan;
    }
  }

  return null;
}

function normalizeSmartWorkspaceSegments(plan: SmartWorkspacePlan, expectedCount: number): SmartWorkspaceSegment[] | null {
  if (!Array.isArray(plan.segments) || plan.segments.length !== expectedCount) {
    return null;
  }

  const segments = plan.segments.map((item, index) => {
    const segment = item as { index?: unknown; title?: unknown; directorText?: unknown };
    const segmentIndex = Number(segment.index);
    return {
      index: Number.isFinite(segmentIndex) ? segmentIndex : index + 1,
      title: String(segment.title || `第 ${index + 1} 段`).trim(),
      directorText: String(segment.directorText || "").trim()
    };
  });

  if (segments.some((segment, index) => segment.index !== index + 1 || !segment.title || !segment.directorText)) {
    return null;
  }

  return segments;
}

function createSmartWorkspace({
  workspaceName,
  scriptSegments,
  segments,
  file,
  voiceMime
}: {
  workspaceName: string;
  sceneDescription: string;
  scriptSegments: string[];
  segments: SmartWorkspaceSegment[];
  file: Express.Multer.File;
  voiceMime: "audio/mp3" | "audio/m4a" | "audio/wav";
}): StoredWorkspace {
  const now = new Date().toISOString();
  const workspaceId = createId("board");
  const referenceNodeId = createId("referenceAudio");
  const audioDataUrl = `data:${voiceMime};base64,${file.buffer.toString("base64")}`;
  const nodes: unknown[] = [
    {
      id: referenceNodeId,
      type: "referenceAudio",
      position: { x: 40, y: 80 },
      data: {
        title: "参考音频",
        text: "声音样本",
        audio: {
          fileName: file.originalname,
          mimeType: voiceMime,
          size: file.size,
          dataUrl: audioDataUrl
        }
      }
    }
  ];
  const edges: unknown[] = [];

  segments.forEach((segment, index) => {
    const y = 80 + index * 300;
    const styleNodeId = createId("voiceStyle");
    const promptNodeId = createId("prompt");
    const cloneNodeId = createId("voiceClone");
    const segmentTitle = segment.title || `第 ${index + 1} 段`;

    nodes.push(
      {
        id: styleNodeId,
        type: "voiceStyle",
        position: { x: 400, y },
        data: {
          title: `${segmentTitle} 导演`,
          text: segment.directorText
        }
      },
      {
        id: promptNodeId,
        type: "prompt",
        position: { x: 400, y: y + 150 },
        data: {
          title: `${segmentTitle} 台词`,
          text: scriptSegments[index]
        }
      },
      {
        id: cloneNodeId,
        type: "voiceClone",
        position: { x: 820, y: y + 60 },
        data: {
          title: `${segmentTitle} 克隆`,
          instruction: segment.directorText,
          text: scriptSegments[index]
        }
      }
    );

    edges.push(
      createWorkflowEdge(referenceNodeId, "audio", cloneNodeId, "voice"),
      createWorkflowEdge(styleNodeId, "style", cloneNodeId, "instruction"),
      createWorkflowEdge(promptNodeId, "text", cloneNodeId, "text")
    );
  });

  return {
    id: workspaceId,
    name: workspaceName,
    createdAt: now,
    updatedAt: now,
    nodes,
    edges,
    stashItems: []
  };
}

function createWorkflowEdge(source: string, sourceHandle: string, target: string, targetHandle: string) {
  return {
    id: createId("edge"),
    source,
    sourceHandle,
    target,
    targetHandle,
    type: "deletable",
    animated: true,
    style: { stroke: "#c5a45d", strokeWidth: 2 }
  };
}

async function readWorkspaceStore(): Promise<WorkspaceStore> {
  try {
    const raw = await readFile(workspaceFilePath, "utf-8");
    return normalizeWorkspaceStore(parseWorkspaceStore(raw));
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? (error as { code?: string }).code : "";
    if (code !== "ENOENT") {
      throw error;
    }

    const now = new Date().toISOString();
    const initial: WorkspaceStore = {
      activeWorkspaceId: "board-initial",
      workspaces: [
        {
          id: "board-initial",
          name: "默认工作台",
          createdAt: now,
          updatedAt: now,
          nodes: [],
          edges: [],
          stashItems: []
        }
      ]
    };
    await writeWorkspaceStore(initial);
    return initial;
  }
}

async function writeWorkspaceStore(store: WorkspaceStore): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const tempPath = `${workspaceFilePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(store, null, 2), "utf-8");
  await rename(tempPath, workspaceFilePath);
}

function parseWorkspaceStore(raw: string): WorkspaceStore {
  try {
    return JSON.parse(raw) as WorkspaceStore;
  } catch (error) {
    const recovered = parseFirstJsonObject(raw);
    if (recovered) {
      return recovered as WorkspaceStore;
    }

    throw error;
  }
}

function parseFirstJsonObject(raw: string): unknown | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(0, index + 1));
        } catch {
          return null;
        }
      }
    }
  }

  return null;
}

function normalizeWorkspaceStore(parsed: WorkspaceStore): WorkspaceStore {
  const workspaces = Array.isArray(parsed.workspaces) ? parsed.workspaces.map(normalizeStoredWorkspace) : [];
  return {
    activeWorkspaceId: parsed.activeWorkspaceId ?? workspaces[0]?.id ?? null,
    workspaces
  };
}

function normalizeWorkspaceName(value: unknown): string {
  const name = String(value || "").trim();
  return name || `未命名工作台 ${new Date().toLocaleString("zh-CN", { hour12: false })}`;
}

function createId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeStoredWorkspace(workspace: StoredWorkspace): StoredWorkspace {
  return {
    ...workspace,
    nodes: Array.isArray(workspace.nodes) ? workspace.nodes : [],
    edges: Array.isArray(workspace.edges) ? workspace.edges : [],
    stashItems: Array.isArray(workspace.stashItems) ? workspace.stashItems : []
  };
}
