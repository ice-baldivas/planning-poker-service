const { test } = require('node:test');
const assert = require('node:assert/strict');
const { sessionStore } = require('../dist/session-store');
const { VOTING_SCALES } = require('../dist/types');

function setup(mode = 'free') {
  const session = sessionStore.createSession(
    'Test',
    VOTING_SCALES.fibonacci,
    mode,
  );
  for (const [id, role] of [
    ['moderator', 'moderator'],
    ['voter', 'team_member'],
    ['viewer', 'observer'],
  ]) {
    sessionStore.addParticipant(session, {
      id,
      role,
      display_name: id,
      has_voted: false,
      is_connected: true,
      socket_id: `${session.id}-${id}`,
    });
  }
  session.moderator_id = 'moderator';
  return session;
}

test('auto-reveal is opt-in, counts disconnected voters and never exposes private votes', () => {
  const session = setup();
  sessionStore.castVote(session, 'moderator', '5');
  sessionStore.disconnectSocket(`${session.id}-voter`);
  sessionStore.setAutoReveal(session, true);
  assert.equal(sessionStore.maybeAutoReveal(session), null);
  sessionStore.castVote(session, 'voter', '5');
  sessionStore.setAutoReveal(session, false);
  assert.equal(sessionStore.maybeAutoReveal(session), null);
  sessionStore.setAutoReveal(session, true);
  const result = sessionStore.maybeAutoReveal(session);
  assert.equal(result.consensus_value, '5');
  assert.equal(result.votes.length, 2);
  assert.equal(sessionStore.maybeAutoReveal(session), null);
  const state = sessionStore.toClientState(session);
  assert.equal(state.auto_reveal, true);
  assert.equal('votes' in state, false);
  assert.equal('revealed_result' in state, false);
  assert.equal(JSON.stringify(state).includes('card_value'), false);
  sessionStore.resetRound(session);
  assert.equal(session.revealed_result, null);
  assert.equal(session.auto_reveal, true);
  assert.equal(sessionStore.maybeAutoReveal(session), null);
});

test('removal and cleanup can complete a round, while public snapshots remain stable', () => {
  const session = setup();
  sessionStore.setAutoReveal(session, true);
  sessionStore.castVote(session, 'moderator', '8');
  sessionStore.disconnectSocket(`${session.id}-voter`);
  session.participants.get('voter').disconnected_at =
    Date.now() - 16 * 60 * 1000;
  const cleanup = sessionStore.cleanup();
  assert.equal(
    cleanup.revealedResults.find((entry) => entry.session_id === session.id)
      .result.consensus_value,
    '8',
  );
  const snapshot = session.revealed_result;
  sessionStore.removeParticipant(session, 'moderator');
  assert.equal(session.revealed_result, snapshot);
  sessionStore.resetRound(session);
  assert.equal(sessionStore.maybeAutoReveal(session), null);
});

test('stories require an active story and clear results on finalization or story changes', () => {
  const session = setup('stories');
  sessionStore.setAutoReveal(session, true);
  assert.equal(sessionStore.maybeAutoReveal(session), null);
  const story = sessionStore.addStory(session, 'A story');
  sessionStore.setActiveStory(session, story.id);
  sessionStore.castVote(session, 'moderator', '3');
  sessionStore.removeParticipant(session, 'voter');
  assert.equal(sessionStore.maybeAutoReveal(session).consensus_value, '3');
  sessionStore.finalizeStory(session, story.id, '3');
  assert.equal(session.revealed_result, null);
  assert.equal(sessionStore.maybeAutoReveal(session), null);
  sessionStore.setActiveStory(session, story.id);
  assert.equal(session.auto_reveal, true);
  assert.equal(session.votes.size, 0);
});
