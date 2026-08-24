import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { applyMiddlewares, applyErrorHandlers } from './middlewares.js';
import apiRoutes from '../routes/index.js';
import config from '../config/env.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIST = path.resolve(__dirname, '../../frontend/dist');

export function createApp() {
  const app = express();

  applyMiddlewares(app);

  // Downloaded media, so the UI can render images/audio it received.
  app.use('/media', express.static(path.resolve('data/media')));

  app.use('/api', apiRoutes);

  if (config.isServer) {
    app.use(express.static(FRONTEND_DIST));
    // SPA fallback — skip real asset extensions so a missing file 404s
    // instead of silently returning index.html.
    const STATIC_EXT = /\.(js|mjs|css|json|png|jpg|jpeg|gif|svg|ico|woff2?|ttf|map)$/i;
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || STATIC_EXT.test(req.path)) return next();
      res.sendFile(path.join(FRONTEND_DIST, 'index.html'));
    });
  }

  applyErrorHandlers(app);

  return app;
}
