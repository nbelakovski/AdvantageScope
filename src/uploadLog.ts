// Copyright (c) 2021-2026 Littleton Robotics
// http://github.com/Mechanical-Advantage
//
// Use of this source code is governed by a BSD
// license that can be found in the LICENSE file
// at the root directory of this project.

window.addEventListener("message", (event) => {
  const LOG_INPUT = document.getElementById("wpilog") as HTMLInputElement;
  const EXIT_BUTTON = document.getElementById("exit") as HTMLButtonElement;
  const CONFIRM_BUTTON = document.getElementById("confirm") as HTMLButtonElement;
  const PROGRESS_TEXT = document.getElementById("progress") as HTMLTableCellElement;

  let messagePort = event.ports[0];
  messagePort.onmessage = (event) => {
    // Update button focus
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

  async function confirm() {
    if (LOG_INPUT.files !== null && LOG_INPUT.files.length > 0) {
      const file = LOG_INPUT.files[0];
      CONFIRM_BUTTON.disabled = true;
      EXIT_BUTTON.disabled = true;

      try {
        // Step 1: Request a presigned PUT URL from the lite server
        PROGRESS_TEXT.innerText = "Requesting upload URL...";
        const urlResponse = await fetch(`upload-log-url?filename=${encodeURIComponent(file.name)}`);
        if (!urlResponse.ok) {
          const text = await urlResponse.text();
          PROGRESS_TEXT.innerText = `Failed to get upload URL: ${text || urlResponse.statusText}`;
          CONFIRM_BUTTON.disabled = false;
          EXIT_BUTTON.disabled = false;
          return;
        }
        const { url } = (await urlResponse.json()) as { url: string };

        // Step 2: Upload the file directly to Spaces using the presigned URL
        PROGRESS_TEXT.innerText = "Uploading...";
        const uploadResponse = await fetch(url, {
          method: "PUT",
          body: file,
          headers: {
            "Content-Type": "application/octet-stream"
          }
        });

        if (uploadResponse.ok) {
          PROGRESS_TEXT.innerText = "Upload complete!";
          window.setTimeout(() => messagePort.postMessage(null), 1500);
        } else {
          PROGRESS_TEXT.innerText = `Upload failed: ${uploadResponse.statusText || uploadResponse.status}`;
          CONFIRM_BUTTON.disabled = false;
          EXIT_BUTTON.disabled = false;
        }
      } catch (e) {
        PROGRESS_TEXT.innerText = `Upload failed: ${e instanceof Error ? e.message : String(e)}`;
        CONFIRM_BUTTON.disabled = false;
        EXIT_BUTTON.disabled = false;
      }
    } else {
      messagePort.postMessage(null);
    }
  }

  EXIT_BUTTON.addEventListener("click", () => {
    messagePort.postMessage(null);
  });
  CONFIRM_BUTTON.addEventListener("click", () => confirm());
  window.addEventListener("keydown", (event) => {
    if (event.code === "Enter") confirm();
  });
});
