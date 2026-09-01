import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const OWNER = 'jamshidnabizada7-boop';
const REPO = 'GLM-UPDATE-ON-SEHATAI';

// Get token
let token = process.env.GITHUB_TOKEN;
if (!token) {
  try {
    token = execSync('gh auth token', { encoding: 'utf8' }).trim();
  } catch (e) {
    console.error('Failed to get token from gh auth token:', e.message);
  }
}

if (!token) {
  console.error('No GitHub token available. Please log in with gh auth login or set GITHUB_TOKEN.');
  process.exit(1);
}

const headers = {
  'Authorization': `token ${token}`,
  'Accept': 'application/vnd.github.v3+json',
  'User-Agent': 'Node-GitHub-Push',
  'Content-Type': 'application/json'
};

async function ghFetch(endpoint, options = {}) {
  const url = endpoint.startsWith('https://') ? endpoint : `https://api.github.com${endpoint}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...headers, ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`GitHub API Error ${res.status} ${res.statusText}: ${JSON.stringify(data)}`);
  }
  return data;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const ignoredPatterns = [
  /^\.git(\/|\\|$)/,
  /^node_modules(\/|\\|$)/,
  /^\.next(\/|\\|$)/,
  /^\.vercel(\/|\\|$)/,
  /^\.env(\.local|\.production)?$/,
  /^db\/.*\.db(-journal)?$/,
  /^tool-results(\/|\\|$)/,
  /^\.claude(\/|\\|$)/,
  /^\.z-ai-config(\/|\\|$)/,
  /\.log$/,
  /\.tsbuildinfo$/,
  /next-env\.d\.ts$/,
  /^\.DS_Store$/
];

function isIgnored(relPath) {
  const normalized = relPath.replace(/\\/g, '/');
  for (const pat of ignoredPatterns) {
    if (pat.test(normalized)) return true;
  }
  return false;
}

function getAllFiles(dir, base = '') {
  let files = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.join(base, entry.name);
    if (isIgnored(relPath)) continue;

    if (entry.isDirectory()) {
      files = files.concat(getAllFiles(fullPath, relPath));
    } else if (entry.isFile()) {
      files.push({ fullPath, relPath: relPath.replace(/\\/g, '/') });
    }
  }
  return files;
}

const isBinary = (filePath) => {
  const binaryExts = ['.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.eot', '.mp3', '.wav', '.webp', '.zip', '.tar', '.gz'];
  const ext = path.extname(filePath).toLowerCase();
  return binaryExts.includes(ext);
};

async function getLatestCommitSha() {
  try {
    const branches = await ghFetch(`/repos/${OWNER}/${REPO}/branches`);
    const mainBranch = branches.find(b => b.name === 'main') || branches[0];
    if (mainBranch) return mainBranch.commit.sha;
  } catch (e) {
    // repository might be empty
  }
  return null;
}

async function main() {
  console.log(`\n========================================`);
  console.log(`Pushing project to GitHub: ${OWNER}/${REPO}`);
  console.log(`========================================\n`);

  const parentSha = await getLatestCommitSha();
  console.log(`Latest remote commit: ${parentSha || 'None (empty repo)'}`);

  const rootDir = process.cwd();
  const allFiles = getAllFiles(rootDir);
  console.log(`Total files to sync: ${allFiles.length}`);

  const textFiles = allFiles.filter(f => !isBinary(f.fullPath));
  const binaryFiles = allFiles.filter(f => isBinary(f.fullPath));

  console.log(`- Text files (inline in tree): ${textFiles.length}`);
  console.log(`- Binary files (uploaded as blobs): ${binaryFiles.length}`);

  const treeEntries = [];

  // 1. Process binary files one by one with a small delay
  if (binaryFiles.length > 0) {
    console.log(`\nUploading ${binaryFiles.length} binary files as blobs...`);
    for (let i = 0; i < binaryFiles.length; i++) {
      const file = binaryFiles[i];
      const content = fs.readFileSync(file.fullPath).toString('base64');
      
      let blobRes;
      let attempts = 0;
      while (attempts < 3) {
        try {
          blobRes = await ghFetch(`/repos/${OWNER}/${REPO}/git/blobs`, {
            method: 'POST',
            body: JSON.stringify({ content, encoding: 'base64' })
          });
          break;
        } catch (err) {
          attempts++;
          console.warn(`[Retry ${attempts}] Failed to upload ${file.relPath}: ${err.message}`);
          await sleep(2000 * attempts);
        }
      }

      if (!blobRes) {
        throw new Error(`Failed to upload binary file ${file.relPath} after retries.`);
      }

      treeEntries.push({
        path: file.relPath,
        mode: '100644',
        type: 'blob',
        sha: blobRes.sha
      });

      console.log(`  [${i + 1}/${binaryFiles.length}] Uploaded ${file.relPath}`);
      await sleep(300); // 300ms pause to respect rate limits
    }
  }

  // 2. Process text files directly in tree entries
  console.log(`\nProcessing ${textFiles.length} text files...`);
  for (const file of textFiles) {
    const content = fs.readFileSync(file.fullPath, 'utf8');
    treeEntries.push({
      path: file.relPath,
      mode: '100644',
      type: 'blob',
      content: content
    });
  }

  console.log(`\nCreating Git tree with ${treeEntries.length} items...`);
  const treeRes = await ghFetch(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: treeEntries })
  });
  console.log(`Git tree created: ${treeRes.sha}`);

  console.log(`\nCreating Git commit...`);
  const commitRes = await ghFetch(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: 'SehatAI: Complete Healthcare AI Assistant application codebase',
      tree: treeRes.sha,
      parents: parentSha ? [parentSha] : []
    })
  });
  console.log(`Commit created: ${commitRes.sha}`);

  console.log(`\nUpdating branch ref (refs/heads/main)...`);
  try {
    await ghFetch(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
      method: 'PATCH',
      body: JSON.stringify({
        sha: commitRes.sha,
        force: true
      })
    });
    console.log(`Updated refs/heads/main to commit ${commitRes.sha}`);
  } catch (e) {
    console.log(`Creating refs/heads/main...`);
    await ghFetch(`/repos/${OWNER}/${REPO}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({
        ref: 'refs/heads/main',
        sha: commitRes.sha
      })
    });
    console.log(`Created refs/heads/main pointing to commit ${commitRes.sha}`);
  }

  // Ensure default branch is set to main
  try {
    await ghFetch(`/repos/${OWNER}/${REPO}`, {
      method: 'PATCH',
      body: JSON.stringify({ default_branch: 'main' })
    });
  } catch (e) {}

  console.log(`\n========================================`);
  console.log(`🎉 SUCCESS: Code successfully pushed to GitHub!`);
  console.log(`Repository URL: https://github.com/${OWNER}/${REPO}`);
  console.log(`Branch URL:     https://github.com/${OWNER}/${REPO}/tree/main`);
  console.log(`Commit SHA:     ${commitRes.sha}`);
  console.log(`Total Files:    ${allFiles.length}`);
  console.log(`========================================\n`);
}

main().catch(err => {
  console.error('\n❌ Push failed:', err);
  process.exit(1);
});
