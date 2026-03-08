const express = require('express');
const router = express.Router();
const {
  createTeacher,
  getTeachers,
  getTeacher,
  getMySchedule,          // ← new
  getTeacherScheduleById  // ← new (admin use)
} = require('../controllers/TeacherController');
const { auth } = require('../middleware/auth');

router.use(auth); // all teacher routes require login

router.post('/',    createTeacher);
router.get('/',     getTeachers);

// ── Personal schedule endpoints ───────────────────────────────────────────────
// Teacher hits this to see their own weekly timetable
// GET /api/teachers/my-schedule
// GET /api/teachers/my-schedule?status=Published   (default)
// GET /api/teachers/my-schedule?status=any         (Draft + Published)
// GET /api/teachers/my-schedule?academicYear=2025
router.get('/my-schedule', getMySchedule);

// Admin hits this to view any teacher's schedule
// GET /api/teachers/:id/schedule
router.get('/:id/schedule', getTeacherScheduleById);

router.get('/:id', getTeacher);

module.exports = router;