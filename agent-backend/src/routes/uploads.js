// Shared multipart plumbing: the story-026 multer/raw-body error mapping and
// the request-time-limit upload middleware, used by the project file routes
// and the org library routes (story 006-001).

import multer from 'multer';

import { config } from '../config.js';

export const MAX_UPLOAD_FILES = 20;

// Read limits at request time, not import time, so STORAGE_MAX_FILE_BYTES
// overrides (and tests that adjust config) always match storage.js.
export function uploadMiddleware(req, res, next) {
  multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.storage.maxFileBytes, files: MAX_UPLOAD_FILES },
  }).array('files')(req, res, next);
}

// Errors thrown by body-parsing middleware (multer, express.raw) never reach
// route handlers — without this they fall through to Express's default HTML
// 500/413. Maps them to the { error, code } shape StorageError responses use.
export function bodyErrorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({
        error: `File exceeds ${config.storage.maxFileBytes} bytes; nothing was uploaded`,
        code: 'too_large',
      });
      return;
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      res.status(400).json({
        error: `Too many files in one upload (max ${MAX_UPLOAD_FILES})`,
        code: 'too_many_files',
      });
      return;
    }
    res.status(400).json({ error: err.message, code: 'upload_error' });
    return;
  }
  // express.raw() body-size rejection
  if (err?.type === 'entity.too.large') {
    res.status(413).json({
      error: `Content exceeds ${config.storage.maxFileBytes} bytes`,
      code: 'too_large',
    });
    return;
  }
  next(err);
}
