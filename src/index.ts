import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import sessionRoutes from './routes/sessions';
import { registerHandlers } from './socket/handlers';

const PORT = Number(process.env.PORT ?? 3000);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:4200';

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

// Manual CORS — only allow the Angular frontend origin.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

app.use('/api/sessions', sessionRoutes);

// ---------------------------------------------------------------------------
// HTTP + Socket.io
// ---------------------------------------------------------------------------
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
});

io.on('connection', socket => {
  registerHandlers(io, socket);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  console.log(`Planning Poker service listening on http://localhost:${PORT}`);
});
