const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");

let apiServer = null;

async function startApiServer() {
  const appRoot = app.isPackaged ? app.getAppPath() : path.resolve(__dirname, "..");
  const serverEntry = app.isPackaged
    ? path.join(process.resourcesPath, "server", "index.cjs")
    : path.join(appRoot, "build", "server", "index.cjs");
  const staticDir = app.isPackaged ? path.join(process.resourcesPath, "dist") : path.join(appRoot, "dist");

  process.env.MIMO_NO_AUTO_LISTEN = "1";
  process.env.MIMO_DATA_DIR = app.getPath("userData");
  process.env.MIMO_STATIC_DIR = staticDir;

  const serverModule = require(serverEntry);
  apiServer = serverModule.startServer(0, "127.0.0.1");

  await new Promise((resolve, reject) => {
    apiServer.once("listening", resolve);
    apiServer.once("error", reject);
  });

  const address = apiServer.address();
  if (!address || typeof address !== "object") {
    throw new Error("Unable to determine local API server port.");
  }

  return `http://127.0.0.1:${address.port}`;
}

async function createWindow() {
  const localUrl = await startApiServer();
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 1024,
    minHeight: 720,
    title: "MiMo Audio Workstation",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  await window.loadURL(localUrl);
}

app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (error) {
    dialog.showErrorBox(
      "MiMo Audio Workstation failed to start",
      error instanceof Error ? error.message : String(error)
    );
    app.quit();
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow().catch((error) => {
        dialog.showErrorBox("MiMo Audio Workstation failed to start", String(error));
      });
    }
  });
});

app.on("before-quit", () => {
  if (apiServer) {
    apiServer.close();
    apiServer = null;
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
