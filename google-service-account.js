import fs from 'node:fs';

function parseCredentials(content, source) {
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid Google service-account JSON from ${source}. Set GOOGLE_SERVICE_ACCOUNT_JSON to the complete JSON key or GOOGLE_SERVICE_ACCOUNT_FILE to an accessible JSON file.`
    );
  }
}

export function loadGoogleServiceAccountCredentials({
  filePath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
  json = process.env.GOOGLE_SERVICE_ACCOUNT_JSON
} = {}) {
  const configuredFile = String(filePath || '').trim();
  const configuredJson = String(json || '').trim();
  if (configuredFile) {
    return parseCredentials(fs.readFileSync(configuredFile, 'utf8'), 'GOOGLE_SERVICE_ACCOUNT_FILE');
  }
  if (!configuredJson) return null;
  if (configuredJson.startsWith('{')) {
    return parseCredentials(configuredJson, 'GOOGLE_SERVICE_ACCOUNT_JSON');
  }

  // Accept a file path here for compatibility with local .env files that used the wrong variable.
  return parseCredentials(fs.readFileSync(configuredJson, 'utf8'), 'the GOOGLE_SERVICE_ACCOUNT_JSON file path');
}
