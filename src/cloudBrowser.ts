// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

import { BOOTSTRAP_CLOUD_DOWNLOAD_ICON } from "./shared/CloudIcons";

interface FileEntry {
  key: string; // relative to Tribecbot/, e.g. "Champs/file.wpilog"
  size: number;
}

interface TreeNode {
  folders: Map<string, TreeNode>;
  files: { name: string; key: string; size: number }[];
  expanded: boolean;
}

function makeNode(): TreeNode {
  return { folders: new Map(), expanded: true, files: [] };
}

function buildTree(files: FileEntry[]): TreeNode {
  const root = makeNode();
  for (const file of files) {
    const parts = file.key.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!node.folders.has(part)) {
        node.folders.set(part, makeNode());
      }
      node = node.folders.get(part)!;
    }
    const filename = parts[parts.length - 1];
    node.files.push({ name: filename, key: file.key, size: file.size });
  }
  return root;
}

window.addEventListener("message", (event) => {
  const EXIT_BUTTON = document.getElementById("exit") as HTMLButtonElement;
  const DOWNLOAD_BUTTON = document.getElementById("download") as HTMLButtonElement;
  const TREE_CONTAINER = document.getElementById("tree") as HTMLElement;
  const STATUS_TEXT = document.getElementById("status") as HTMLElement;

  const messagePort = event.ports[0];
  const selectedKeys = new Set<string>();
  const filesByKey = new Map<string, FileEntry>();

  messagePort.onmessage = (event) => {
    if (typeof event.data === "object" && "isFocused" in event.data) {
      Array.from(document.getElementsByTagName("button")).forEach((button) => {
        if (event.data.isFocused) {
          button.classList.remove("blurred");
        } else {
          button.classList.add("blurred");
        }
      });
    }
  };

  function renderNode(node: TreeNode, container: HTMLElement, depth: number) {
    const sortedFolders = Array.from(node.folders.entries()).sort(([a], [b]) => a.localeCompare(b));
    const sortedFiles = [...node.files].sort((a, b) => -a.name.localeCompare(b.name));

    for (const [name, child] of sortedFolders) {
      // Folder row
      const folderRow = document.createElement("div");
      folderRow.className = "tree-folder";
      folderRow.style.paddingLeft = `${6 + depth * 18}px`;
      container.appendChild(folderRow);

      const toggle = document.createElement("span");
      toggle.className = "tree-toggle";
      toggle.textContent = child.expanded ? "\u25bc" : "\u25ba";
      folderRow.appendChild(toggle);

      const label = document.createElement("span");
      label.className = "tree-folder-name";
      label.textContent = name;
      folderRow.appendChild(label);

      // Children container
      const childrenDiv = document.createElement("div");
      childrenDiv.hidden = !child.expanded;
      container.appendChild(childrenDiv);

      renderNode(child, childrenDiv, depth + 1);

      folderRow.addEventListener("click", () => {
        child.expanded = !child.expanded;
        toggle.textContent = child.expanded ? "\u25bc" : "\u25ba";
        childrenDiv.hidden = !child.expanded;
      });
    }

    for (const file of sortedFiles) {
      const fileRow = document.createElement("div");
      fileRow.className = "file-item tree-file";
      fileRow.style.paddingLeft = `${6 + depth * 18}px`;
      if (selectedKeys.has(file.key)) fileRow.classList.add("selected");
      container.appendChild(fileRow);

      const img = document.createElement("img");
      const ext = file.name.split(".").pop() ?? "wpilog";
      img.src = `../icons/${ext === "wpilogxz" ? "wpilog" : ext}-icon.png`;
      img.onerror = () => {
        img.src = "../icons/wpilog-icon.png";
      };
      fileRow.appendChild(img);

      const nameSpan = document.createElement("span");
      nameSpan.className = "tree-name";
      nameSpan.textContent = file.name;
      fileRow.appendChild(nameSpan);

      const sizeSpan = document.createElement("span");
      sizeSpan.className = "tree-size";
      sizeSpan.textContent = "(" + (file.size < 1e5 ? "<0.1" : Math.round(file.size / 1e5) / 10) + " MB)";
      fileRow.appendChild(sizeSpan);

      const downloadButton = document.createElement("div");
      downloadButton.className = "tree-download-button";
      downloadButton.title = "Download log";
      downloadButton.innerHTML = BOOTSTRAP_CLOUD_DOWNLOAD_ICON;
      fileRow.appendChild(downloadButton);

      fileRow.addEventListener("click", () => {
        selectedKeys.clear();
        document.querySelectorAll(".tree-file").forEach((row) => {
          row.classList.remove("selected");
        });
        selectedKeys.add(file.key);
        fileRow.classList.add("selected");
      });

      fileRow.addEventListener("dblclick", () => {
        messagePort.postMessage([{ key: file.key, size: file.size }]);
      });

      downloadButton.addEventListener("click", async (event) => {
        event.stopPropagation();
        try {
          downloadButton.style.opacity = "0.5";
          downloadButton.style.pointerEvents = "none";
          const encodedPath = file.key.split("/").map(encodeURIComponent).join("/");
          const response = await fetch(`../cloud-log-url/${encodedPath}`);
          if (!response.ok) {
            const text = await response.text();
            alert("Failed to get download URL: " + (text || response.statusText));
            return;
          }
          const data = (await response.json()) as { url?: string };
          if (typeof data.url !== "string" || data.url.length === 0) {
            alert("Failed to get download URL.");
            return;
          }
          const a = document.createElement("a");
          a.href = data.url;
          a.rel = "noopener";
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
        } catch (error) {
          alert("Error downloading file: " + (error instanceof Error ? error.message : String(error)));
        } finally {
          downloadButton.style.opacity = "1";
          downloadButton.style.pointerEvents = "auto";
        }
      });
    }
  }

  async function loadTree() {
    try {
      const response = await fetch("../cloud-browse");
      if (!response.ok) {
        STATUS_TEXT.textContent = "Failed to load: " + response.statusText;
        return;
      }
      const files: FileEntry[] = await response.json();
      filesByKey.clear();
      files.forEach((file) => filesByKey.set(file.key, file));
      STATUS_TEXT.hidden = true;

      if (files.length === 0) {
        STATUS_TEXT.textContent = "No log files found in Tribecbot/.";
        STATUS_TEXT.hidden = false;
        return;
      }

      const root = buildTree(files);
      TREE_CONTAINER.innerHTML = "";
      TREE_CONTAINER.hidden = false;
      renderNode(root, TREE_CONTAINER, 0);
    } catch (e) {
      STATUS_TEXT.textContent = "Failed to load: " + (e instanceof Error ? e.message : String(e));
    }
  }

  function confirm() {
    if (selectedKeys.size === 0) {
      alert("Please select a log file.");
      return;
    }
    const selected = Array.from(selectedKeys)
      .map((key) => {
        const match = filesByKey.get(key);
        return match === undefined ? null : { key: match.key, size: match.size };
      })
      .filter((entry): entry is { key: string; size: number } => entry !== null);
    messagePort.postMessage(selected);
  }

  EXIT_BUTTON.addEventListener("click", () => messagePort.postMessage(null));
  DOWNLOAD_BUTTON.addEventListener("click", confirm);
  window.addEventListener("keydown", (event) => {
    if (event.code === "Enter") confirm();
  });

  loadTree();
});
