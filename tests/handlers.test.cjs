const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerHandlers } = require('../dist/socket/handlers');
const { sessionStore } = require('../dist/session-store');

function harness() {
  const events = [];
  const io = {
    sockets: { sockets: new Map() },
    to: (room) => ({ emit: (name, data) => events.push({ room, name, data }) }),
  };
  function client(id) {
    const handlers = new Map();
    const messages = [];
    const socket = {
      id,
      handshake: { address: id },
      on: (name, callback) => handlers.set(name, callback),
      emit: (name, data) => messages.push({ name, data }),
      join() {},
      leave() {},
      to: io.to,
    };
    io.sockets.sockets.set(id, socket);
    registerHandlers(io, socket);
    return { messages, send: (name, data) => handlers.get(name)(data) };
  }
  const moderator = client('mod');
  moderator.send('create_session', {
    name: 'Test',
    display_name: 'Mod',
    voting_scale_id: 'fibonacci',
    session_mode: 'free',
  });
  const state = moderator.messages[0].data;
  return { events, client, moderator, state };
}

test('setting is moderator-only, strictly validated, and enabling completed round reveals once', () => {
  const { client, moderator, state, events } = harness();
  const voter = client('voter');
  voter.send('join_session', { session_id: state.id, display_name: 'Voter' });
  voter.send('set_auto_reveal', { enabled: true });
  assert.equal(voter.messages.at(-1).data.code, 'FORBIDDEN');
  for (const payload of [undefined, null, {}, { enabled: 'true' }]) {
    moderator.send('set_auto_reveal', payload);
    assert.equal(moderator.messages.at(-1).data.code, 'INVALID_INPUT');
  }
  moderator.send('cast_vote', { card_value: '5' });
  voter.send('cast_vote', { card_value: '8' });
  assert.equal(
    events.some((event) => event.name === 'votes_revealed'),
    false,
  );
  moderator.send('set_auto_reveal', { enabled: true });
  assert.deepEqual(
    events.slice(-2).map((event) => event.name),
    ['auto_reveal_changed', 'votes_revealed'],
  );
  assert.equal(events.at(-1).data.consensus, false);
  moderator.send('set_auto_reveal', { enabled: true });
  assert.equal(
    events.filter((event) => event.name === 'votes_revealed').length,
    1,
  );
  const stranger = client('stranger');
  stranger.send('set_auto_reveal', { enabled: true });
  assert.equal(stranger.messages.at(-1).data.code, 'NOT_IN_SESSION');
});

test('final vote broadcasts status before results; join/reconnect replay is private and reset clears it', () => {
  const { client, moderator, state, events } = harness();
  moderator.send('set_auto_reveal', { enabled: true });
  moderator.send('cast_vote', { card_value: '3' });
  assert.deepEqual(
    events.slice(-2).map((event) => event.name),
    ['vote_cast', 'votes_revealed'],
  );
  const viewer = client('viewer');
  viewer.send('join_session', {
    session_id: state.id,
    display_name: 'Viewer',
    role: 'observer',
  });
  assert.deepEqual(
    viewer.messages.map((event) => event.name),
    ['session_state', 'votes_revealed'],
  );
  const refresh = client('refresh');
  refresh.send('join_session', {
    session_id: state.id,
    participant_id: state.your_participant_id,
  });
  assert.deepEqual(
    refresh.messages.map((event) => event.name),
    ['session_state', 'votes_revealed'],
  );
  assert.equal(
    events.filter((event) => event.name === 'votes_revealed').length,
    1,
  );
  refresh.send('reset_round');
  const late = client('late');
  late.send('join_session', { session_id: state.id, display_name: 'Late' });
  assert.deepEqual(
    late.messages.map((event) => event.name),
    ['session_state'],
  );
});

test('disconnection blocks until removal; removed voter gets no result', () => {
  const { client, moderator, state, events } = harness();
  const voter = client('voter');
  voter.send('join_session', { session_id: state.id, display_name: 'Voter' });
  moderator.send('set_auto_reveal', { enabled: true });
  moderator.send('cast_vote', { card_value: '13' });
  voter.send('disconnect');
  assert.equal(sessionStore.getSession(state.id).status, 'voting');
  moderator.send('remove_participant', {
    participant_id: voter.messages[0].data.your_participant_id,
  });
  assert.deepEqual(
    events.slice(-2).map((event) => event.name),
    ['participant_removed', 'votes_revealed'],
  );
  assert.equal(events.at(-1).data.votes.length, 1);
});
