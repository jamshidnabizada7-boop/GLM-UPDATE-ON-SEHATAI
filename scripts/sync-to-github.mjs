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
  'User-Agent': 'Node-GitHub-Sync',
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

async function ensureRepoInitialized() {
  try {
    const branches = await ghFetch(`/repos/${OWNER}/${REPO}/branches`);
    if (branches.length > 0) return branches[0].commit.sha;
  } catch (e) {
    // repository might be empty
  }

  console.log('Repository is empty. Initializing with README.md...');
  const readmeContent = fs.existsSync('README.md') 
    ? fs.readFileSync('README.md', 'utf8') 
    : '# ' + REPO;
    
  const initRes = await ghFetch(`/repos/${OWNER}/${REPO}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'Initial repository setup',
      content: Buffer.from(readmeContent).toString('base64'),
      branch: 'main'
    })
  });
  console.log('Repository initialized.');
  return initRes.commit.sha;
}

async function main() {
  console.log(`Starting sync to ${OWNER}/${REPO}...`);
  const parentSha = await ensureRepoInitialized();

  const rootDir = process.cwd();
  const allFiles = getAllFiles(rootDir);
  console.log(`Found ${allFiles.length} files to commit.`);

  const treeEntries = [];
  const batchSize = 10;
  
  for (let i = 0; i < allFiles.length; i += batchSize) {
    const batch = allFiles.slice(i, i + batchSize);
    await Promise.all(batch.map(async (file) => {
      const binary = isBinary(file.fullPath);
      let content;
      let encoding;
      if (binary) {
        content = fs.readFileSync(file.fullPath).toString('base64');
        encoding = 'base64';
      } else {
        content = fs.readFileSync(file.fullPath, 'utf8');
        encoding = 'utf-8';
      }

      const blobRes = await ghFetch(`/repos/${OWNER}/${REPO}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content, encoding })
      });

      treeEntries.push({
        path: file.relPath,
        mode: '100644',
        type: 'blob',
        sha: blobRes.sha
      });
    }));
    process.stdout.write(`Uploaded blobs: ${Math.min(i + batchSize, allFiles.length)}/${allFiles.length}\r`);
  }
  console.log(`\nAll ${treeEntries.length} blobs uploaded successfully.`);

  console.log('Creating Git tree...');
  const treeRes = await ghFetch(`/repos/${OWNER}/${REPO}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({ tree: treeEntries })
  });
  console.log(`Tree created: ${treeRes.sha}`);

  console.log('Creating Git commit...');
  const commitRes = await ghFetch(`/repos/${OWNER}/${REPO}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message: 'Complete SehatAI application from GLM',
      tree: treeRes.sha,
      parents: parentSha ? [parentSha] : []
    })
  });
  console.log(`Commit created: ${commitRes.sha}`);

  console.log('Updating ref refs/heads/main...');
  await ghFetch(`/repos/${OWNER}/${REPO}/git/refs/heads/main`, {
    method: 'PATCH',
    body: JSON.stringify({
      sha: commitRes.sha,
      force: true
    })
  });
  console.log('Updated ref refs/heads/main successfully.');

  console.log(`\n🎉 Successfully pushed all files to https://github.com/${OWNER}/${REPO}/tree/main`);
}

main().catch(err => {
  console.error('Push failed:', err);
  process.exit(1);
});
