const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Fast chunked UTF-8 Base64 encoding (handles huge files cleanly)
function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToText(base64) {
  const binary = atob(base64.replace(/\n/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

async function ghRequest(endpoint, token, options = {}) {
  const res = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const rawText = await res.text();
  const data = rawText ? JSON.parse(rawText) : {};

  if (!res.ok) {
    const err = new Error(data.message || `GitHub HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function runSingleAction(action, token, owner) {
  const repoOwner = action.owner || owner;

  switch (action.type) {
    case "list_repos": {
      const repos = await ghRequest("/user/repos?sort=updated&per_page=25", token);
      return {
        ok: true,
        summary: `Found ${repos.length} repositories`,
        data: repos.map((r) => `${r.name} (${r.private ? "private" : "public"})`)
      };
    }

    case "list_files": {
      const cleanPath = (action.path || "").replace(/^\/+|\/+$/g, "");
      const endpoint = cleanPath
        ? `/repos/${repoOwner}/${action.repo}/contents/${cleanPath}`
        : `/repos/${repoOwner}/${action.repo}/contents`;
      const items = await ghRequest(endpoint, token);
      const list = Array.isArray(items)
        ? items.map((i) => `${i.type === "dir" ? "[DIR]" : "[FILE]"} ${i.path}`)
        : [`[FILE] ${items.path}`];
      return {
        ok: true,
        summary: `Listed ${list.length} item(s) in ${action.repo}/${cleanPath || ""}`,
        data: list
      };
    }

    case "create_repo": {
      try {
        const existing = await ghRequest(`/repos/${repoOwner}/${action.name}`, token);
        return {
          ok: true,
          summary: `Using existing repo "${existing.name}"`,
          url: existing.html_url
        };
      } catch (_) {}

      const repo = await ghRequest("/user/repos", token, {
        method: "POST",
        body: JSON.stringify({
          name: action.name,
          description: action.description || "",
          private: Boolean(action.private),
          auto_init: true
        })
      });
      await sleep(1500);
      return {
        ok: true,
        summary: `Created repo "${repo.name}"`,
        url: repo.html_url
      };
    }

    case "delete_repo": {
      await ghRequest(`/repos/${repoOwner}/${action.repo}`, token, {
        method: "DELETE"
      });
      return {
        ok: true,
        summary: `Deleted repository "${repoOwner}/${action.repo}"`
      };
    }

    case "read_file": {
      const cleanPath = action.path.replace(/^\/+/, "");
      const file = await ghRequest(
        `/repos/${repoOwner}/${action.repo}/contents/${cleanPath}`,
        token
      );
      let decoded = base64ToText(file.content);
      if (decoded.length > 45000) {
        decoded =
          decoded.slice(0, 45000) +
          "\n\n/* [TRUNCATED: File exceeded 45,000 characters] */";
      }
      return {
        ok: true,
        summary: `Read ${action.repo}/${cleanPath}`,
        data: decoded
      };
    }

    case "create_or_update_file": {
      if (typeof action.content !== "string") {
        throw new Error(
          `Missing file content for "${action.path}". Put the code in a Markdown code block and reference it with "use_code_block".`
        );
      }
      const cleanPath = action.path.replace(/^\/+/, "");

      const uploadFile = async () => {
        let existingSha;
        try {
          const existing = await ghRequest(
            `/repos/${repoOwner}/${action.repo}/contents/${cleanPath}`,
            token
          );
          existingSha = existing.sha;
        } catch (_) {}

        return await ghRequest(
          `/repos/${repoOwner}/${action.repo}/contents/${cleanPath}`,
          token,
          {
            method: "PUT",
            body: JSON.stringify({
              message: action.commit_message || `Update ${cleanPath} via Gemini`,
              content: textToBase64(action.content),
              ...(existingSha ? { sha: existingSha } : {})
            })
          }
        );
      };

      let res;
      try {
        res = await uploadFile();
      } catch (_) {
        await sleep(1500);
        res = await uploadFile();
      }

      return {
        ok: true,
        summary: `Saved ${action.repo}/${cleanPath}`,
        url: res.content.html_url
      };
    }

    case "append_to_file": {
      if (typeof action.content !== "string") {
        throw new Error(`Missing append content for "${action.path}".`);
      }
      const cleanPath = action.path.replace(/^\/+/, "");
      const existing = await ghRequest(
        `/repos/${repoOwner}/${action.repo}/contents/${cleanPath}`,
        token
      );
      const combined = base64ToText(existing.content) + "\n" + action.content;

      const res = await ghRequest(
        `/repos/${repoOwner}/${action.repo}/contents/${cleanPath}`,
        token,
        {
          method: "PUT",
          body: JSON.stringify({
            message: action.commit_message || `Append to ${cleanPath} via Gemini`,
            content: textToBase64(combined),
            sha: existing.sha
          })
        }
      );
      return {
        ok: true,
        summary: `Appended to ${action.repo}/${cleanPath}`,
        url: res.content.html_url
      };
    }

    case "delete_file": {
      const cleanPath = action.path.replace(/^\/+/, "");
      const existing = await ghRequest(
        `/repos/${repoOwner}/${action.repo}/contents/${cleanPath}`,
        token
      );
      await ghRequest(
        `/repos/${repoOwner}/${action.repo}/contents/${cleanPath}`,
        token,
        {
          method: "DELETE",
          body: JSON.stringify({
            message: action.commit_message || `Delete ${cleanPath} via Gemini`,
            sha: existing.sha
          })
        }
      );
      return {
        ok: true,
        summary: `Deleted ${action.repo}/${cleanPath}`
      };
    }

    case "publish_pages": {
      const branch = action.branch || "main";
      const folder = action.path || "/";
      try {
        const page = await ghRequest(
          `/repos/${repoOwner}/${action.repo}/pages`,
          token,
          {
            method: "POST",
            body: JSON.stringify({ source: { branch, path: folder } })
          }
        );
        return {
          ok: true,
          summary: `Published GitHub Pages for "${action.repo}"`,
          url: page.html_url
        };
      } catch (err) {
        if (err.status === 409) {
          const existingPage = await ghRequest(
            `/repos/${repoOwner}/${action.repo}/pages`,
            token
          );
          return {
            ok: true,
            summary: `GitHub Pages active for "${action.repo}"`,
            url: existingPage.html_url
          };
        }
        throw err;
      }
    }

    case "create_issue": {
      const issue = await ghRequest(
        `/repos/${repoOwner}/${action.repo}/issues`,
        token,
        {
          method: "POST",
          body: JSON.stringify({
            title: action.title,
            body: action.body || ""
          })
        }
      );
      return {
        ok: true,
        summary: `Opened issue #${issue.number}: ${action.title}`,
        url: issue.html_url
      };
    }

    case "trigger_workflow": {
      const workflowFile = action.workflow || "build.yml";
      const ref = action.ref || "main";
      await ghRequest(
        `/repos/${repoOwner}/${action.repo}/actions/workflows/${workflowFile}/dispatches`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ ref })
        }
      );
      return {
        ok: true,
        summary: `Triggered workflow "${workflowFile}" on ${action.repo}`,
        url: `https://github.com/${repoOwner}/${action.repo}/actions`,
        buildRepo: action.repo
      };
    }

    case "check_builds": {
      const runsData = await ghRequest(
        `/repos/${repoOwner}/${action.repo}/actions/runs?per_page=3`,
        token
      );
      const latestRun = runsData.workflow_runs?.[0];

      let releaseAssets = [];
      try {
        const latestRelease = await ghRequest(
          `/repos/${repoOwner}/${action.repo}/releases/latest`,
          token
        );
        releaseAssets = (latestRelease.assets || []).map((a) => ({
          name: a.name,
          url: a.browser_download_url,
          sizeMB: (a.size / (1024 * 1024)).toFixed(2)
        }));
      } catch (_) {}

      let artifacts = [];
      try {
        const artData = await ghRequest(
          `/repos/${repoOwner}/${action.repo}/actions/artifacts?per_page=5`,
          token
        );
        artifacts = (artData.artifacts || [])
          .filter((a) => !a.expired)
          .map((a) => ({
            name: a.name,
            url: latestRun
              ? latestRun.html_url
              : `https://github.com/${repoOwner}/${action.repo}/actions`,
            sizeMB: (a.size_in_bytes / (1024 * 1024)).toFixed(2)
          }));
      } catch (_) {}

      const statusText = latestRun
        ? `${latestRun.name}: ${latestRun.status}${
            latestRun.conclusion ? ` (${latestRun.conclusion})` : ""
          }`
        : "No workflow runs found yet";

      return {
        ok: true,
        summary: `Build status for "${action.repo}" → ${statusText}`,
        url: latestRun
          ? latestRun.html_url
          : `https://github.com/${repoOwner}/${action.repo}/actions`,
        downloads: releaseAssets.length > 0 ? releaseAssets : artifacts,
        buildRepo: action.repo
      };
    }

    default:
      return { ok: false, summary: `Unknown action type: ${action.type}` };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "EXECUTE_GITHUB_ACTIONS") return;

  (async () => {
    const { githubToken } = await chrome.storage.local.get(["githubToken"]);
    if (!githubToken) {
      sendResponse({
        ok: false,
        error: "GitHub token missing. Click the extension icon and save your token."
      });
      return;
    }

    try {
      const user = await ghRequest("/user", githubToken);
      const owner = user.login;
      const results = [];

      for (const action of message.actions) {
        try {
          const res = await runSingleAction(action, githubToken, owner);
          results.push(res);
        } catch (err) {
          results.push({ ok: false, summary: `${action.type} failed: ${err.message}` });
        }
      }

      sendResponse({ ok: true, results });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true;
});
