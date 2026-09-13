/**
 * READ-ONLY view of OpenCode's provider credentials.
 *
 * OpenCode 2.x imports the legacy `auth.json` once into its own database and
 * never writes the file again; credentials live behind `/api/integration` and
 * `/api/credential`, and there is no HTTP route that hands a key back.
 * OpenChamber needs the raw credential for provider quota lookups, voice keys
 * and the GitHub and Linear helpers, so `readAuthFile()` answers from two
 * sources: the database OpenCode actually uses (`credential-db.js`), with the
 * legacy file underneath for anything the database does not know. The shape
 * is the legacy `auth.json` map either way. Nothing here writes: a write
 * would be invisible to the running OpenCode and drift from what it uses.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { readCredentialsFromDb, resolveCredentialDbPath } from './credential-db.js';

const OPENCODE_DATA_DIR = path.join(os.homedir(), '.local', 'share', 'opencode');
const AUTH_FILE = path.join(OPENCODE_DATA_DIR, 'auth.json');

function readLegacyAuthFile() {
  if (!fs.existsSync(AUTH_FILE)) {
    return {};
  }
  try {
    const content = fs.readFileSync(AUTH_FILE, 'utf8');
    const trimmed = content.trim();
    if (!trimmed) {
      return {};
    }
    return JSON.parse(trimmed);
  } catch (error) {
    console.error('Failed to read auth file:', error);
    throw new Error('Failed to read OpenCode auth configuration');
  }
}

/** The credentials OpenCode uses, keyed by provider id, in the legacy entry shape. */
function readAuthFile() {
  const legacy = readLegacyAuthFile();
  const stored = readCredentialsFromDb({
    dbPath: resolveCredentialDbPath({ dataDir: OPENCODE_DATA_DIR, path }),
    fs,
  });
  return stored ? { ...legacy, ...stored } : legacy;
}

function getProviderAuth(providerId) {
  const auth = readAuthFile();
  return auth[providerId] || null;
}

function listProviderAuths() {
  const auth = readAuthFile();
  return Object.keys(auth);
}

export {
  readAuthFile,
  getProviderAuth,
  listProviderAuths,
  AUTH_FILE,
  OPENCODE_DATA_DIR
};
