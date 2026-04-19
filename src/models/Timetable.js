const mongoose = require('mongoose');
const Schema   = mongoose.Schema;

// ── Individual schedule entry ─────────────────────────────────────────────────
const timetableEntrySchema = new Schema({
  Course: {
    type:     Schema.Types.ObjectId,
    ref:      'Course',
    required: true,
  },
  teacher: {
    type:     Schema.Types.ObjectId,
    ref:      'Teacher',
    required: true,
  },
  room: {
    type:     Schema.Types.ObjectId,
    ref:      'Room',
    required: true,
  },

  // 'Theory' or 'Lab'
  type: {
    type:     String,
    enum:     ['Theory', 'Lab'],
    required: true,
  },

  dayOfWeek: {
    type:     String,
    required: true,
    enum:     ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  },

  startTime: { type: String, required: true },  // e.g. "10:20"
  endTime:   { type: String, required: true },  // e.g. "11:15"

  // Which semester this session belongs to (important for multi-semester timetables)
  semester: { type: Number },

  // Division (always 'A' for full class theory; 'A' for lab rotation blocks too)
  division: { type: String, default: 'A' },

  // Batch — null for theory, 'A1'/'A2'/'A3' for lab sessions
  batch: { type: String, default: null },

}, { _id: false });


// ── Timetable document ────────────────────────────────────────────────────────
const timetableSchema = new Schema({
  // Human-readable name, e.g. "Timetable Sem 8 — 2025 (2026-03-07 14:30:00)"
  name: {
    type:     String,
    required: true,
    unique:   true,
  },

  // Which student group this timetable is for
  studentGroup: {
    department: {
      type: Schema.Types.ObjectId,
      ref:  'Department',
    },
    semester: {
      type:     Number,
      required: true,
    },
    // Division string ('A', 'B' etc.) — kept as string for simplicity
    // (the schema comment about ObjectId ref was aspirational; string is simpler)
    division: {
      type:    String,
      default: 'A',
    },
  },

  // Academic year this timetable is for, e.g. 2025
  academicYear: {
    type:    Number,
    default: () => new Date().getFullYear(),
  },

  status: {
    type:    String,
    enum:    ['Draft', 'Published', 'Archived'],
    default: 'Draft',
  },

  publishedAt: { type: Date },

  schedule: [timetableEntrySchema],

}, { timestamps: true });


// ── Indexes for fast teacher/semester lookups ─────────────────────────────────
timetableSchema.index({ 'schedule.teacher': 1, status: 1 });
timetableSchema.index({ 'studentGroup.semester': 1, status: 1 });
timetableSchema.index({ 'studentGroup.department': 1, status: 1 });
timetableSchema.index({ academicYear: 1, status: 1 });


module.exports = mongoose.model('Timetable', timetableSchema);