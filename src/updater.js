const { autoUpdater } = require("electron-updater");

// Updates stay disabled until a HIRA-owned release feed is configured.
// Do not point production builds at the legacy OpenWhispr repository.
const HIRA_UPDATES_ENABLED = false;
const UPDATES_DISABLED_MESSAGE =
  "HIRA updates are disabled until a HIRA-owned update feed is configured";

class UpdateManager {
  constructor() {
    this.updateAvailable = false;
    this.updateDownloaded = false;
    this.lastUpdateInfo = null;
    this.isInstalling = false;
    this.isDownloading = false;
    this.isQuittingForUpdate = false;
    this.handleBeforeQuitForUpdate = null;
    this.eventListeners = [];
    this.updateCheckInterval = null;
    this.windowManager = null;
    this._suppressNotification = false;

    this.setupAutoUpdater();
  }

  setWindowManager(windowManager) {
    this.windowManager = windowManager;
  }

  setupAutoUpdater() {
    // Keep any previously downloaded update from being installed implicitly.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    if (process.env.NODE_ENV === "development" || !HIRA_UPDATES_ENABLED) {
      return;
    }

    // A HIRA-owned feed must be added here before updates are re-enabled.
    autoUpdater.logger = console;
    this.setupEventHandlers();
  }

  setupEventHandlers() {
    const handlers = {
      "checking-for-update": () => {
        this.notifyRenderers("checking-for-update");
      },
      "update-available": (info) => {
        this.updateAvailable = true;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-available", info);
        const nPrefs = this.windowManager?.notificationPrefs || {};
        const notifAllowed =
          nPrefs.notificationsEnabled !== false && nPrefs.notifyUpdates !== false;
        if (this.windowManager && info && !this._suppressNotification && notifAllowed) {
          this.windowManager.showUpdateNotification(info).catch((err) => {
            console.error("Failed to show update notification:", err);
          });
        }
        this._suppressNotification = false;
      },
      "update-not-available": (info) => {
        this.updateAvailable = false;
        this._suppressNotification = false;
        if (!this.updateDownloaded) {
          this.isDownloading = false;
          this.lastUpdateInfo = null;
        }
        this.notifyRenderers("update-not-available", info);
      },
      error: (err) => {
        console.error("❌ Auto-updater error:", err);
        this._suppressNotification = false;
        this.isDownloading = false;
        this.notifyRenderers("update-error", err);
      },
      "download-progress": (progressObj) => {
        console.log(
          `📥 Download progress: ${progressObj.percent.toFixed(2)}% (${(progressObj.transferred / 1024 / 1024).toFixed(2)}MB / ${(progressObj.total / 1024 / 1024).toFixed(2)}MB)`
        );
        this.notifyRenderers("update-download-progress", progressObj);
      },
      "update-downloaded": (info) => {
        console.log("✅ Update downloaded successfully:", info?.version);
        this.updateDownloaded = true;
        this.isDownloading = false;
        if (info) {
          this.lastUpdateInfo = {
            version: info.version,
            releaseDate: info.releaseDate,
            releaseNotes: info.releaseNotes,
            files: info.files,
          };
        }
        this.notifyRenderers("update-downloaded", info);
      },
    };

    Object.entries(handlers).forEach(([event, handler]) => {
      autoUpdater.on(event, handler);
      this.eventListeners.push({ event, handler });
    });

    // electron-updater and Squirrel.Mac emit this on Electron's native
    // autoUpdater (before any windows close), not on the electron-updater instance.
    this.handleBeforeQuitForUpdate = () => {
      this.isQuittingForUpdate = true;
      if (this.windowManager) {
        this.windowManager.isQuitting = true;
        this.windowManager.hotkeyManager.unregisterAll();
      }
    };
    require("electron").autoUpdater.on("before-quit-for-update", this.handleBeforeQuitForUpdate);
  }

  notifyRenderers(channel, data) {
    // Read window refs live from windowManager: cached refs go stale when the
    // control panel is created after boot (start minimized) or recreated.
    const { mainWindow, controlPanelWindow } = this.windowManager ?? {};
    for (const win of [mainWindow, controlPanelWindow]) {
      if (win && !win.isDestroyed() && win.webContents) {
        win.webContents.send(channel, data);
      }
    }
  }

  async checkForUpdates() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          updateAvailable: false,
          message: "Update checks are disabled in development mode",
        };
      }

      if (!HIRA_UPDATES_ENABLED) {
        return { updateAvailable: false, message: UPDATES_DISABLED_MESSAGE };
      }

      console.log("🔍 Checking for updates...");
      this._suppressNotification = true;
      const result = await autoUpdater.checkForUpdates();

      if (result?.isUpdateAvailable && result?.updateInfo) {
        console.log("📋 Update available:", result.updateInfo.version);
        return {
          updateAvailable: true,
          version: result.updateInfo.version,
          releaseDate: result.updateInfo.releaseDate,
          files: result.updateInfo.files,
          releaseNotes: result.updateInfo.releaseNotes,
        };
      } else {
        console.log("✅ Already on latest version");
        return {
          updateAvailable: false,
          message: "You are running the latest version",
        };
      }
    } catch (error) {
      console.error("❌ Update check error:", error);
      throw error;
    }
  }

  async downloadUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update downloads are disabled in development mode",
        };
      }

      if (!HIRA_UPDATES_ENABLED) {
        return { success: false, message: UPDATES_DISABLED_MESSAGE };
      }

      if (this.isDownloading) {
        return {
          success: true,
          message: "Download already in progress",
        };
      }

      if (this.updateDownloaded) {
        return {
          success: true,
          message: "Update already downloaded. Ready to install.",
        };
      }

      this.isDownloading = true;
      console.log("📥 Starting update download...");
      await autoUpdater.downloadUpdate();
      console.log("📥 Download initiated successfully");

      return { success: true, message: "Update download started" };
    } catch (error) {
      this.isDownloading = false;
      console.error("❌ Update download error:", error);
      throw error;
    }
  }

  async installUpdate() {
    try {
      if (process.env.NODE_ENV === "development") {
        return {
          success: false,
          message: "Update installation is disabled in development mode",
        };
      }

      if (!HIRA_UPDATES_ENABLED) {
        return { success: false, message: UPDATES_DISABLED_MESSAGE };
      }

      if (!this.updateDownloaded) {
        return {
          success: false,
          message: "No update available to install",
        };
      }

      if (this.isInstalling) {
        return {
          success: false,
          message: "Update installation already in progress",
        };
      }

      this.isInstalling = true;
      console.log("🔄 Installing update and restarting...");

      const isSilent = process.platform === "win32";
      autoUpdater.quitAndInstall(isSilent, true);

      return { success: true, message: "Update installation started" };
    } catch (error) {
      this.isInstalling = false;
      console.error("❌ Update installation error:", error);
      throw error;
    }
  }

  async getAppVersion() {
    try {
      const { app } = require("electron");
      return { version: app.getVersion() };
    } catch (error) {
      console.error("❌ Error getting app version:", error);
      throw error;
    }
  }

  async getUpdateStatus() {
    try {
      return {
        updateAvailable: this.updateAvailable,
        updateDownloaded: this.updateDownloaded,
        isDevelopment: process.env.NODE_ENV === "development",
      };
    } catch (error) {
      console.error("❌ Error getting update status:", error);
      throw error;
    }
  }

  async getUpdateInfo() {
    try {
      return this.lastUpdateInfo;
    } catch (error) {
      console.error("❌ Error getting update info:", error);
      throw error;
    }
  }

  checkForUpdatesOnStartup() {
    if (HIRA_UPDATES_ENABLED && process.env.NODE_ENV !== "development") {
      setTimeout(() => {
        console.log("🔄 Checking for updates on startup...");
        autoUpdater.checkForUpdates().catch((err) => {
          console.error("Startup update check failed:", err);
        });
      }, 3000);

      const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
      this.updateCheckInterval = setInterval(() => {
        console.log("🔄 Periodic update check...");
        autoUpdater.checkForUpdates().catch((err) => {
          console.error("Periodic update check failed:", err);
        });
      }, FOUR_HOURS_MS);
    }
  }

  cleanup() {
    if (this.updateCheckInterval) {
      clearInterval(this.updateCheckInterval);
      this.updateCheckInterval = null;
    }
    this.eventListeners.forEach(({ event, handler }) => {
      autoUpdater.removeListener(event, handler);
    });
    this.eventListeners = [];
    if (this.handleBeforeQuitForUpdate) {
      require("electron").autoUpdater.removeListener(
        "before-quit-for-update",
        this.handleBeforeQuitForUpdate
      );
      this.handleBeforeQuitForUpdate = null;
    }
  }
}

module.exports = UpdateManager;
