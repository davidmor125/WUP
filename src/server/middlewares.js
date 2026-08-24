import cors from 'cors';
import express from 'express';
import morgan from 'morgan';
import logger from '../utils/logger.js';

export function applyMiddlewares(app) {
  app.use(cors());
  // Base64 inflates a file by ~33%, so a 16 MB attachment arrives as ~21 MB.
  app.use(express.json({ limit: '32mb' }));
  app.use(express.urlencoded({ extended: true, limit: '32mb' }));
  app.use(morgan('dev'));
}

export function applyErrorHandlers(app) {
  app.use((req, res) => {
    res.status(404).json({
      success: false,
      message: `Route ${req.method} ${req.originalUrl} not found`,
    });
  });

  app.use((err, req, res, _next) => {
    const statusCode = err.statusCode || 500;
    logger.error(`${statusCode} - ${err.message} - ${req.originalUrl}`);
    res.status(statusCode).json({
      success: false,
      message: statusCode === 500 ? 'Internal server error' : err.message,
      ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
  });
}
