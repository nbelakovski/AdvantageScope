// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { BOOTSTRAP_CLOUD_CHECK_ICON, BOOTSTRAP_CLOUD_UPLOAD_ICON } from "./shared/CloudIcons";

interface FileUploadState {
  file: File;
  status: "pending" | "checking" | "skipped" | "uploading" | "complete" | "error";
  errorMessage?: string;
  progress: number; // 0-100
  existsInCloud: boolean;
}

function formatFileSize(sizeBytes: number): string {
  const sizeMb = sizeBytes / 1e6;
  return (sizeMb < 0.1 ? "<0.1" : (Math.round(sizeMb * 10) / 10).toString()) + " MB";
}

window.addEventListener("message", (event) => {
  const FILES_INPUT = document.getElementById("files-input") as HTMLInputElement;
  const DROP_ZONE = document.getElementById("drop-zone") as HTMLDivElement;
  const FILE_LIST_CONTAINER = document.getElementById("file-list-container") as HTMLDivElement;
  const FILE_LIST = document.getElementById("file-list") as HTMLDivElement;
  const EXIT_BUTTON = document.getElementById("exit") as HTMLButtonElement;
  const STATUS_MESSAGE = document.getElementById("status-message") as HTMLDivElement;

  let messagePort = event.ports[0];
  const fileStates = new Map<string, FileUploadState>();
  let uploadSession = 0;

  // Handle focus state from main process
  messagePort.onmessage = (event) => {
    if (typeof event.data === "object" && "isFocused" in event.data) {
      Array.from(document.getElementsByTagName("button")).forEach((button) => {
        if (event.data.isFocused) {
          button.classList.remove("blurred");
        } else {
          button.classList.add("blurred");
        }
      });
      return;
    }
  };

  // Set up drag and drop
  DROP_ZONE.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.stopPropagation();
    DROP_ZONE.classList.add("dragover");
  });

  DROP_ZONE.addEventListener("dragleave", (e) => {
    e.preventDefault();
    e.stopPropagation();
    DROP_ZONE.classList.remove("dragover");
  });

  DROP_ZONE.addEventListener("drop", (e) => {
    e.preventDefault();
    e.stopPropagation();
    DROP_ZONE.classList.remove("dragover");

    if (e.dataTransfer?.files) {
      void handleFileSelection(e.dataTransfer.files);
    }
  });

  DROP_ZONE.addEventListener("click", () => {
    if (!FILES_INPUT.disabled) {
      FILES_INPUT.click();
    }
  });

  // File input change
  FILES_INPUT.addEventListener("change", () => {
    if (FILES_INPUT.files) {
      void handleFileSelection(FILES_INPUT.files);
      FILES_INPUT.value = "";
    }
  });

  // Exit button
  EXIT_BUTTON.addEventListener("click", () => {
    messagePort.postMessage(null);
  });

  async function handleFileSelection(files: FileList) {
    const currentSession = ++uploadSession;
    fileStates.clear();

    Array.from(files).forEach((file) => {
      // Only accept log files
      if (
        file.name.endsWith(".wpilog") ||
        file.name.endsWith(".wpilogxz") ||
        file.name.endsWith(".rlog") ||
        file.name.endsWith(".log")
      ) {
        fileStates.set(file.name, {
          file,
          status: "pending",
          progress: 0,
          existsInCloud: false
        });
      }
    });

    updateFileList();

    if (fileStates.size > 0) {
      await startUploadWorkflow(currentSession);
    } else {
      setStatusMessage("No valid log files selected", "error");
    }
  }

  async function startUploadWorkflow(currentSession: number) {
    FILES_INPUT.disabled = true;
    EXIT_BUTTON.disabled = true;
    DROP_ZONE.classList.add("disabled");
    setStatusMessage("Checking S3 for existing files...", "info");

    try {
      await checkFilesInS3(currentSession);
      if (currentSession !== uploadSession) {
        return;
      }

      const filesToUpload = Array.from(fileStates.values()).filter(
        (state) => !state.existsInCloud && state.status !== "error"
      );

      if (filesToUpload.length === 0) {
        setStatusMessage("All files already exist in S3", "info");
        return;
      }

      setStatusMessage(`Uploading ${filesToUpload.length} file(s)...`, "info");
      await Promise.all(filesToUpload.map((fileState) => uploadFile(fileState, currentSession)));
      if (currentSession !== uploadSession) {
        return;
      }

      const failedCount = Array.from(fileStates.values()).filter((state) => state.status === "error").length;
      if (failedCount === 0) {
        setStatusMessage("All files uploaded successfully!", "success");
      } else {
        setStatusMessage(`Upload complete with ${failedCount} error(s)`, "error");
      }
    } catch (e) {
      if (currentSession === uploadSession) {
        setStatusMessage(`Upload failed: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    } finally {
      if (currentSession === uploadSession) {
        FILES_INPUT.disabled = false;
        EXIT_BUTTON.disabled = false;
        DROP_ZONE.classList.remove("disabled");
      }
    }
  }

  function updateFileList() {
    if (fileStates.size === 0) {
      FILE_LIST_CONTAINER.hidden = true;
      FILE_LIST.innerHTML = "";
      return;
    }

    FILE_LIST_CONTAINER.hidden = false;
    FILE_LIST.innerHTML = "";

    fileStates.forEach((state) => {
      const itemElement = document.createElement("div");
      itemElement.className = "file-item";
      itemElement.id = `file-${state.file.name}`;
      let itemStateClass = "";

      let statusText = "";
      let iconClass = "";
      let iconType: "upload" | "check" = "upload";

      switch (state.status) {
        case "pending":
          statusText = "Ready";
          break;
        case "checking":
          statusText = "Checking...";
          iconClass = "uploading";
          break;
        case "skipped":
          statusText = "Already in S3";
          itemStateClass = "synced";
          iconType = "check";
          break;
        case "uploading":
          statusText = `${state.progress}%`;
          iconClass = "uploading";
          itemStateClass = "uploading";
          break;
        case "complete":
          statusText = "Complete";
          itemStateClass = "synced";
          iconType = "check";
          break;
        case "error":
          statusText = `Error: ${state.errorMessage || "Unknown"}`;
          itemStateClass = "error";
          break;
      }

      if (itemStateClass.length > 0) {
        itemElement.classList.add(itemStateClass);
      }

      const iconElement = document.createElement("span");
      iconElement.className = `file-item-icon ${iconClass}`.trim();
      iconElement.innerHTML = iconType === "check" ? BOOTSTRAP_CLOUD_CHECK_ICON : BOOTSTRAP_CLOUD_UPLOAD_ICON;

      const nameElement = document.createElement("span");
      nameElement.className = "file-item-name";
      nameElement.textContent = `${state.file.name} (${formatFileSize(state.file.size)})`;

      const statusElement = document.createElement("span");
      statusElement.className = "file-item-status";
      statusElement.textContent = statusText;

      itemElement.append(iconElement, nameElement, statusElement);

      FILE_LIST.appendChild(itemElement);
    });
  }

  async function checkFilesInS3(currentSession: number) {
    const checkPromises = Array.from(fileStates.values()).map(async (state) => {
      if (currentSession !== uploadSession) {
        return;
      }
      state.status = "checking";
      updateFileList();

      try {
        const response = await fetch(`/cloud-exists?filename=${encodeURIComponent(state.file.name)}`);
        if (response.ok) {
          const data = (await response.json()) as { exists: boolean };
          state.existsInCloud = data.exists;
          state.status = data.exists ? "skipped" : "pending";
        } else {
          state.existsInCloud = false;
          state.status = "pending";
        }
      } catch (e) {
        state.existsInCloud = false;
        state.status = "pending";
      }

      if (currentSession === uploadSession) {
        updateFileList();
      }
    });

    await Promise.all(checkPromises);
  }

  async function uploadFile(fileState: FileUploadState, currentSession: number) {
    if (currentSession !== uploadSession) {
      return;
    }
    fileState.status = "uploading";
    fileState.progress = 0;
    updateFileList();

    try {
      // Step 1: Get presigned URL
      const urlResponse = await fetch(
        `/www/upload-log-url?filename=${encodeURIComponent(fileState.file.name)}`
      );
      if (!urlResponse.ok) {
        throw new Error(`Failed to get upload URL: ${urlResponse.statusText}`);
      }
      const { url } = (await urlResponse.json()) as { url: string };

      // Step 2: Upload with progress tracking
      await uploadWithProgress(url, fileState, currentSession);

      if (currentSession !== uploadSession) {
        return;
      }

      fileState.status = "complete";
      fileState.progress = 100;
    } catch (e) {
      if (currentSession === uploadSession) {
        fileState.status = "error";
        fileState.errorMessage = e instanceof Error ? e.message : String(e);
      }
    }

    if (currentSession === uploadSession) {
      updateFileList();
    }
  }

  function uploadWithProgress(url: string, fileState: FileUploadState, currentSession: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();

      // Progress tracking
      xhr.upload.addEventListener("progress", (event) => {
        if (currentSession === uploadSession && event.lengthComputable) {
          fileState.progress = Math.round((event.loaded / event.total) * 100);
          updateFileList();
        }
      });

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
        } else {
          reject(new Error(`Upload failed with status ${xhr.status}`));
        }
      });

      xhr.addEventListener("error", () => {
        reject(new Error("Upload failed"));
      });

      xhr.addEventListener("abort", () => {
        reject(new Error("Upload cancelled"));
      });

      xhr.open("PUT", url, true);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.send(fileState.file);
    });
  }

  function setStatusMessage(message: string, type: "info" | "error" | "success") {
    STATUS_MESSAGE.textContent = message;
    STATUS_MESSAGE.className = `status-message ${type}`;
  }
});
