import { Server, Socket } from 'socket.io';
import { sessionStore } from '../session-store';
import { InternalParticipant, ParticipantRole, SessionMode, VOTING_SCALES, VotingScaleId } from '../types';
import { generateId, sanitize, sanitizeText } from '../utils';
import { rateLimiter } from '../rate-limiter';

type ErrorCode =
  | 'INVALID_INPUT'
  | 'SESSION_NOT_FOUND'
  | 'NOT_IN_SESSION'
  | 'FORBIDDEN'
  | 'INVALID_CARD'
  | 'INVALID_STATE'
  | 'NOT_FOUND'
  | 'RATE_LIMITED';

function emitError(socket: Socket, code: ErrorCode, message: string): void {
  socket.emit('error', { code, message });
}

export function registerHandlers(io: Server, socket: Socket): void {
  const ip = socket.handshake.address;

  // ---------------------------------------------------------------------------
  // create_session
  // Payload: { name, voting_scale_id, session_mode, display_name }
  // ---------------------------------------------------------------------------
  socket.on('create_session', (data: {
    name?: string;
    voting_scale_id?: string;
    session_mode?: string;
    display_name?: string;
  }) => {
    const name = sanitize(data.name ?? '');
    const display_name = sanitize(data.display_name ?? '');
    const scale = VOTING_SCALES[data.voting_scale_id as VotingScaleId];
    const mode: SessionMode = data.session_mode === 'free' ? 'free' : 'stories';

    if (!name || !display_name || !scale) {
      emitError(socket, 'INVALID_INPUT', 'name, display_name, and a valid voting_scale_id are required');
      return;
    }

    const session = sessionStore.createSession(name, scale, mode);
    const participant_id = generateId();

    const participant: InternalParticipant = {
      id: participant_id,
      display_name,
      role: 'scrum_master',
      is_connected: true,
      has_voted: false,
      socket_id: socket.id,
    };

    session.scrum_master_id = participant_id;
    sessionStore.addParticipant(session, participant);

    socket.join(session.id);
    socket.emit('session_state', {
      ...sessionStore.toClientState(session),
      your_participant_id: participant_id,
    });
  });

  // ---------------------------------------------------------------------------
  // join_session
  // Payload: { session_id, display_name, role?, participant_id? }
  // participant_id is provided on reconnect so the server can restore state.
  // ---------------------------------------------------------------------------
  socket.on('join_session', (data: {
    session_id?: string;
    display_name?: string;
    role?: ParticipantRole;
    participant_id?: string;
  }) => {
    const session_id = sanitize(data.session_id ?? '');

    if (!session_id) {
      emitError(socket, 'INVALID_INPUT', 'session_id is required');
      return;
    }

    const session = sessionStore.getSession(session_id);
    if (!session) {
      if (!rateLimiter.isAllowed(ip)) {
        emitError(socket, 'RATE_LIMITED', 'Too many failed join attempts. Try again in a minute.');
        return;
      }
      rateLimiter.recordFailedAttempt(ip);
      emitError(socket, 'SESSION_NOT_FOUND', 'Session not found');
      return;
    }

    // Reconnect path: existing participant_id supplied and found in session.
    if (data.participant_id) {
      const existing = session.participants.get(data.participant_id);
      if (existing) {
        sessionStore.updateSocket(session, data.participant_id, socket.id);
        socket.join(session.id);
        socket.emit('session_state', {
          ...sessionStore.toClientState(session),
          your_participant_id: data.participant_id,
        });
        socket.to(session.id).emit('participant_reconnected', { participant_id: data.participant_id });
        rateLimiter.resetAttempts(ip);
        return;
      }
    }

    // New join path.
    const display_name = sanitize(data.display_name ?? '');
    if (!display_name) {
      emitError(socket, 'INVALID_INPUT', 'display_name is required');
      return;
    }

    const role: ParticipantRole = data.role === 'observer' ? 'observer' : 'team_member';
    const participant_id = generateId();

    const participant: InternalParticipant = {
      id: participant_id,
      display_name,
      role,
      is_connected: true,
      has_voted: false,
      socket_id: socket.id,
    };

    sessionStore.addParticipant(session, participant);
    rateLimiter.resetAttempts(ip);

    socket.join(session.id);
    socket.emit('session_state', {
      ...sessionStore.toClientState(session),
      your_participant_id: participant_id,
    });

    socket.to(session.id).emit('participant_joined', {
      id: participant_id,
      display_name,
      role,
      is_connected: true,
      has_voted: false,
    });
  });

  // ---------------------------------------------------------------------------
  // cast_vote
  // Payload: { card_value }
  // ---------------------------------------------------------------------------
  socket.on('cast_vote', (data: { card_value?: string }) => {
    const lookup = sessionStore.getParticipantBySocket(socket.id);
    if (!lookup) { emitError(socket, 'NOT_IN_SESSION', 'Not in a session'); return; }
    const { session, participant } = lookup;

    if (!data.card_value || !session.voting_scale.cards.includes(data.card_value)) {
      emitError(socket, 'INVALID_CARD', 'card_value must be a valid card for this session\'s scale');
      return;
    }

    const ok = sessionStore.castVote(session, participant.id, data.card_value);
    if (!ok) { emitError(socket, 'INVALID_STATE', 'Cannot vote in the current session state'); return; }

    io.to(session.id).emit('vote_cast', { participant_id: participant.id });
  });

  // ---------------------------------------------------------------------------
  // reveal_votes  (Scrum Master only)
  // ---------------------------------------------------------------------------
  socket.on('reveal_votes', () => {
    const lookup = sessionStore.getParticipantBySocket(socket.id);
    if (!lookup) { emitError(socket, 'NOT_IN_SESSION', 'Not in a session'); return; }
    const { session, participant } = lookup;

    if (participant.role !== 'scrum_master') {
      emitError(socket, 'FORBIDDEN', 'Only the Scrum Master can reveal votes');
      return;
    }

    const result = sessionStore.revealVotes(session);
    if (!result) { emitError(socket, 'INVALID_STATE', 'Cannot reveal votes in the current session state'); return; }

    io.to(session.id).emit('votes_revealed', result);
  });

  // ---------------------------------------------------------------------------
  // reset_round  (Scrum Master only)
  // ---------------------------------------------------------------------------
  socket.on('reset_round', () => {
    const lookup = sessionStore.getParticipantBySocket(socket.id);
    if (!lookup) { emitError(socket, 'NOT_IN_SESSION', 'Not in a session'); return; }
    const { session, participant } = lookup;

    if (participant.role !== 'scrum_master') {
      emitError(socket, 'FORBIDDEN', 'Only the Scrum Master can reset the round');
      return;
    }

    const round_number = sessionStore.resetRound(session);
    io.to(session.id).emit('round_reset', { round_number });
  });

  // ---------------------------------------------------------------------------
  // add_story  (Scrum Master only)
  // Payload: { title, description? }
  // ---------------------------------------------------------------------------
  socket.on('add_story', (data: { title?: string; description?: string }) => {
    const lookup = sessionStore.getParticipantBySocket(socket.id);
    if (!lookup) { emitError(socket, 'NOT_IN_SESSION', 'Not in a session'); return; }
    const { session, participant } = lookup;

    if (participant.role !== 'scrum_master') {
      emitError(socket, 'FORBIDDEN', 'Only the Scrum Master can add stories');
      return;
    }

    const title = sanitize(data.title ?? '');
    if (!title) { emitError(socket, 'INVALID_INPUT', 'Story title is required'); return; }

    const description = data.description ? sanitizeText(data.description) : undefined;
    const story = sessionStore.addStory(session, title, description);
    io.to(session.id).emit('story_added', story);
  });

  // ---------------------------------------------------------------------------
  // set_active_story  (Scrum Master only)
  // Payload: { story_id }
  // ---------------------------------------------------------------------------
  socket.on('set_active_story', (data: { story_id?: string }) => {
    const lookup = sessionStore.getParticipantBySocket(socket.id);
    if (!lookup) { emitError(socket, 'NOT_IN_SESSION', 'Not in a session'); return; }
    const { session, participant } = lookup;

    if (participant.role !== 'scrum_master') {
      emitError(socket, 'FORBIDDEN', 'Only the Scrum Master can set the active story');
      return;
    }

    const ok = sessionStore.setActiveStory(session, data.story_id ?? '');
    if (!ok) { emitError(socket, 'NOT_FOUND', 'Story not found'); return; }

    io.to(session.id).emit('active_story_changed', { story_id: data.story_id });
  });

  // ---------------------------------------------------------------------------
  // finalize_story  (Scrum Master only)
  // Payload: { story_id, final_estimate }
  // ---------------------------------------------------------------------------
  socket.on('finalize_story', (data: { story_id?: string; final_estimate?: string }) => {
    const lookup = sessionStore.getParticipantBySocket(socket.id);
    if (!lookup) { emitError(socket, 'NOT_IN_SESSION', 'Not in a session'); return; }
    const { session, participant } = lookup;

    if (participant.role !== 'scrum_master') {
      emitError(socket, 'FORBIDDEN', 'Only the Scrum Master can finalize stories');
      return;
    }

    const estimate = sanitize(data.final_estimate ?? '');
    if (!estimate) { emitError(socket, 'INVALID_INPUT', 'final_estimate is required'); return; }

    const story = sessionStore.finalizeStory(session, data.story_id ?? '', estimate);
    if (!story) { emitError(socket, 'NOT_FOUND', 'Story not found'); return; }

    io.to(session.id).emit('story_finalized', story);
  });

  // ---------------------------------------------------------------------------
  // transfer_sm  (Scrum Master only)
  // Payload: { new_sm_id }
  // ---------------------------------------------------------------------------
  socket.on('transfer_sm', (data: { new_sm_id?: string }) => {
    const lookup = sessionStore.getParticipantBySocket(socket.id);
    if (!lookup) { emitError(socket, 'NOT_IN_SESSION', 'Not in a session'); return; }
    const { session, participant } = lookup;

    if (participant.role !== 'scrum_master') {
      emitError(socket, 'FORBIDDEN', 'Only the Scrum Master can transfer the role');
      return;
    }

    const ok = sessionStore.transferSM(session, data.new_sm_id ?? '');
    if (!ok) { emitError(socket, 'NOT_FOUND', 'Participant not found'); return; }

    io.to(session.id).emit('sm_transferred', { new_sm_id: data.new_sm_id });
  });

  // ---------------------------------------------------------------------------
  // disconnect
  // Marks participant as offline and auto-transfers the SM role after 60s if
  // they do not reconnect (per spec edge case).
  // ---------------------------------------------------------------------------
  socket.on('disconnect', () => {
    const mapping = sessionStore.disconnectSocket(socket.id);
    if (!mapping) return;

    const session = sessionStore.getSession(mapping.session_id);
    if (!session) return;

    io.to(mapping.session_id).emit('participant_left', { participant_id: mapping.participant_id });

    if (session.scrum_master_id !== mapping.participant_id) return;

    // SM disconnected — wait 60 s before auto-transferring the role.
    setTimeout(() => {
      const currentSession = sessionStore.getSession(mapping.session_id);
      if (!currentSession) return;
      const sm = currentSession.participants.get(mapping.participant_id);
      if (!sm || sm.is_connected) return; // SM came back, nothing to do.

      const candidate = Array.from(currentSession.participants.values()).find(
        p => p.id !== mapping.participant_id && p.role !== 'observer' && p.is_connected
      );
      if (!candidate) return;

      sessionStore.transferSM(currentSession, candidate.id);
      io.to(mapping.session_id).emit('sm_transferred', { new_sm_id: candidate.id });
    }, 60_000);
  });
}
