// ─── Auth ───────────────────────────────────────────────────────────────────

export type Role = 'admin' | 'faculty' | 'student' | 'content-creator';

export interface JWTPayload {
  sub: string;        // user id
  email: string;
  role: Role;
  name: string;
  college_id: string; // multi-tenant isolation
  subject?: Subject;  // for faculty only
  sid: string;        // session id (stored in KV for single-session enforcement)
  iat: number;
  exp: number;
}

export interface LoginResponse {
  token: string;
  user: PublicUser;
}

// ─── Users ──────────────────────────────────────────────────────────────────

export interface PublicUser {
  id: string;
  email: string;
  role: Role;
  name: string;
  subject?: Subject;
}

// ─── Questions ──────────────────────────────────────────────────────────────

export type Difficulty = 'easy' | 'medium' | 'hard';
export type QuestionType = 'mcq' | 'msq' | 'integer';
export type Subject = 'physics' | 'chemistry' | 'maths' | 'biology' | 'general';

export interface Question {
  id: string;
  subject: Subject;
  chapter: string;
  difficulty: Difficulty;
  type: QuestionType;
  question_text: string;
  option_a?: string;
  option_b?: string;
  option_c?: string;
  option_d?: string;
  correct_answer?: string; // NEVER sent to student
  explanation?: string;    // NEVER sent to student during exam
  image_r2_key?: string;
  explanation_image_r2_key?: string; // NEVER sent to student during exam
  created_by?: string;
  created_at?: number;
}

/** Safe version sent to students (no answers/explanations/authors) */
export type QuestionSafe = Omit<Question, 'correct_answer' | 'explanation' | 'explanation_image_r2_key' | 'created_by'>;

// ─── Exams ──────────────────────────────────────────────────────────────────

export type ExamStatus = 'draft' | 'published' | 'ongoing' | 'completed' | 'archived';
export type ExamType = 'JEE' | 'NEET' | 'KCET' | 'custom';

export interface ExamConfig {
  negative_marking: boolean;
  marks_correct: number;
  marks_wrong: number;
  duration_minutes: number;
  subjects: Subject[];
  section_wise?: boolean;
}

export interface Exam {
  id: string;
  parent_exam_id?: string;
  version: number;
  title: string;
  description?: string;
  exam_type: ExamType;
  duration_minutes: number;
  total_marks: number;
  status: ExamStatus;
  config_snapshot?: ExamConfig;  // frozen at publish time
  starts_at?: number;
  ends_at?: number;
  created_by?: string;
  created_at: number;
}

export interface ExamQuestion {
  exam_id: string;
  question_id: string;
  order_index: number;
  marks: number;
  negative_marks: number;
}

// Exam payload delivered to student (questions without answers)
export interface ExamPayload {
  exam: Omit<Exam, 'config_snapshot'> & { config: ExamConfig };
  questions: QuestionSafe[];
  server_time: number; // unix timestamp for client timer sync
}

// ─── Exam Attempts ───────────────────────────────────────────────────────────

export type AttemptStatus = 'in_progress' | 'submitted' | 'abandoned' | 'timed_out';

export interface ExamAttempt {
  id: string;
  exam_id: string;
  student_id: string;
  started_at: number;
  last_seen_at: number;
  ip_address?: string;
  user_agent?: string;
  status: AttemptStatus;
}

// ─── Anti-Cheat Events ───────────────────────────────────────────────────────

export type EventType = 'tab_hidden' | 'window_blur' | 'fullscreen_exit' | 'copy' | 'paste' | 'focus_lost';

export interface ExamEvent {
  attempt_id: string;
  event_type: EventType;
  occurred_at: number;
  metadata?: Record<string, unknown>;
}

// ─── Submissions ─────────────────────────────────────────────────────────────

export interface AnswerMap {
  [question_id: string]: string | null; // null = not attempted
}

export interface SubmitRequest {
  exam_id: string;
  attempt_id: string;
  answers: AnswerMap;
  marked_for_review: string[];           // question IDs
  answer_timestamps: Record<string, number>; // question_id → unix ts
  time_taken_seconds: number;
}

export interface SubmissionAnswer {
  submission_id: string;
  question_id: string;
  selected_answer: string | null;
  marked_for_review: boolean;
  answered_at: number | null;
  is_correct: boolean | null;
  marks_awarded: number | null;
}

export interface Submission {
  id: string;
  attempt_id: string;
  exam_id: string;
  student_id: string;
  score: number;
  total_correct: number;
  total_wrong: number;
  total_unattempted: number;
  submitted_at: number;
  time_taken_seconds: number;
}

// ─── Reports ─────────────────────────────────────────────────────────────────

export interface StudentResult {
  submission: Submission;
  answers: SubmissionAnswer[];
  questions: QuestionSafe[];
  rank?: number;
}

export interface ExamReport {
  exam: Exam;
  total_students: number;
  submitted: number;
  in_progress: number;
  abandoned: number;
  average_score: number;
  highest_score: number;
  lowest_score: number;
  results: Array<{
    student: PublicUser;
    submission: Submission;
  }>;
}

// ─── API Helpers ─────────────────────────────────────────────────────────────

export interface ApiError {
  error: string;
  code?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
}
