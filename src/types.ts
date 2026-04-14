export type VotingScaleId = 'fibonacci' | 'tshirt';
export type SessionMode = 'stories' | 'free';

export interface VotingScale {
  id: VotingScaleId;
  name: string;
  cards: string[];
}

export const VOTING_SCALES: Record<VotingScaleId, VotingScale> = {
  fibonacci: {
    id: 'fibonacci',
    name: 'Fibonacci',
    cards: ['1', '2', '3', '5', '8', '13', '21', '?', '∞', '☕'],
  },
  tshirt: {
    id: 'tshirt',
    name: 'T-Shirt Sizes',
    cards: ['XS', 'S', 'M', 'L', 'XL', 'XXL', '?'],
  },
};

export type ParticipantRole = 'scrum_master' | 'team_member' | 'observer';
export type SessionStatus = 'waiting' | 'voting' | 'revealed';
export type StoryStatus = 'pending' | 'active' | 'estimated';

export interface Participant {
  id: string;
  display_name: string;
  role: ParticipantRole;
  is_connected: boolean;
  has_voted: boolean;
}

export interface Story {
  id: string;
  title: string;
  description?: string;
  status: StoryStatus;
  final_estimate?: string;
}

export interface Vote {
  participant_id: string;
  card_value: string;
  submitted_at: string;
}

export interface RoundResult {
  votes: { participant_id: string; display_name: string; card_value: string }[];
  consensus: boolean;
  consensus_value: string | null;
}

/** Client-facing session state — vote values are never included. */
export interface SessionState {
  id: string;
  name: string;
  scrum_master_id: string;
  voting_scale: VotingScale;
  session_mode: SessionMode;
  round_number: number;
  status: SessionStatus;
  current_story_id: string | null;
  stories: Story[];
  participants: Participant[];
  created_at: string;
}

/** Internal participant record — includes the active socket ID. */
export interface InternalParticipant extends Participant {
  socket_id: string | null;
}

/** Internal session — holds vote values server-side only. */
export interface InternalSession {
  id: string;
  name: string;
  scrum_master_id: string;
  voting_scale: VotingScale;
  session_mode: SessionMode;
  round_number: number;
  status: SessionStatus;
  current_story_id: string | null;
  stories: Map<string, Story>;
  participants: Map<string, InternalParticipant>;
  votes: Map<string, Vote>; // keyed by participant_id
  created_at: string;
  last_activity: number;
}
