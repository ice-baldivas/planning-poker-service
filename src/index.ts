import express from 'express'
import { createServer } from 'http'
import { Server } from 'socket.io'
import sessionRoutes from './routes/sessions'
import { registerHandlers } from './socket/handlers'
import { sessionStore } from './session-store'

const PORT = Number(process.env.PORT ?? 3000)
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? 'http://localhost:4200'
const CLEANUP_INTERVAL_MS = 60 * 1000 // 60 seconds

// ---------------------------------------------------------------------------
// Express
// ---------------------------------------------------------------------------
const app = express()
app.use(express.json())

// Manual CORS — only allow the Angular frontend origin.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.sendStatus(204)
    return
  }
  next()
})

app.use('/api/sessions', sessionRoutes)

// ---------------------------------------------------------------------------
// HTTP + Socket.io
// ---------------------------------------------------------------------------
const httpServer = createServer(app)

const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST'] },
})

io.on('connection', (socket) => {
  registerHandlers(io, socket)
})

// ---------------------------------------------------------------------------
// Inactivity cleanup sweep — prunes disconnected participants and expired
// sessions, broadcasting any resulting mutations to affected rooms.
// ---------------------------------------------------------------------------
setInterval(() => {
  const result = sessionStore.cleanup()

  for (const { session_id, participant_id } of result.prunedParticipants) {
    io.to(session_id).emit('participant_removed', { participant_id })
  }
  for (const { session_id, new_sm_id } of result.transfers) {
    io.to(session_id).emit('sm_transferred', { new_sm_id })
  }
}, CLEANUP_INTERVAL_MS).unref()

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  console.log(`Planning Poker service listening on http://localhost:${PORT}`)
})
