const express = require('express');
const mongoose = require('mongoose');
const TimetableGenerator = require('../services/TimetableGenerator');
const Timetable = require('../models/Timetable');
const Course = require('../models/Course');
const Teacher = require('../models/Teacher');
const User = require('../models/User');
const Room = require('../models/Room');
const Department = require('../models/Department');
const { auth } = require('../middleware/auth');

const router = express.Router();
router.use(auth);

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getDayName(dayNumber) {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return days[dayNumber] || 'Monday';
}

/**
 * Convert a generated timetable session → Timetable schema entry.
 * Schema fields: Course (ObjectId), teacher (ObjectId), room (ObjectId),
 *                type ('Theory'|'Lab'), dayOfWeek, startTime, endTime,
 *                semester, division, batch
 */
function sessionToSchemaEntry(session) {
  // Determine entry type for schema enum
  const entryType = (
    session.courseType === 'Lab' ||
    session.courseType === 'Practical' ||
    session.type === 'lab'
  ) ? 'Lab' : 'Theory';

  return {
    Course:    session.course  || session.courseId,
    teacher:   session.teacher || session.teacherId,
    room:      session.room    || session.roomId,
    type:      entryType,
    dayOfWeek: session.dayOfWeek,
    startTime: session.startTime,
    endTime:   session.endTime,
    semester:  session.semester,
    division:  session.division || 'A',
    batch:     session.batch    || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/timetable/generate
// Generate timetable AND auto-save to DB in one step.
// Returns the saved Timetable document + rich session data for frontend preview.
// ─────────────────────────────────────────────────────────────────────────────
router.post('/generate', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const {
      algorithm    = 'genetic',
      semester     = null,
      academicYear = new Date().getFullYear(),
      name,                        // optional custom name
      departmentId = null,
      autoSave     = true,         // set false to just preview without saving
    } = req.body;

    if (semester !== null && (semester < 1 || semester > 8)) {
      return res.status(400).json({ success: false, message: 'Semester must be 1–8 or null' });
    }

    // ── 1. Generate ──────────────────────────────────────────────────────────
    const generator = new TimetableGenerator();
    const result    = await generator.generateTimetable({ algorithm, semester, academicYear, departmentId });

    if (!result.success || !result.timetable.length) {
      return res.status(422).json({
        success: false,
        message: 'Timetable generation produced no sessions',
        conflicts: result.conflicts,
        metrics:   result.metrics,
      });
    }

    // ── 2. Auto-save to DB ───────────────────────────────────────────────────
    let savedDoc = null;

    if (autoSave) {
      // Resolve department ObjectId for studentGroup
      let deptId = departmentId;
      if (!deptId && result.timetable[0]?.department) {
        deptId = result.timetable[0].department;
      }

      // Build a unique name if not provided
      const semLabel = semester ? `Sem ${semester}` : 'All Sems';
      const timetableName = name ||
        `Timetable ${semLabel} — ${academicYear} (${new Date().toISOString().slice(0,19).replace('T',' ')})`;

      // Group sessions by semester for multi-semester saves.
      // If a single semester requested → one Timetable doc.
      // If all semesters → one doc per semester.
      const semGroups = {};
      result.timetable.forEach(s => {
        const key = s.semester || 'unknown';
        if (!semGroups[key]) semGroups[key] = [];
        semGroups[key].push(s);
      });

      const savedDocs = [];

      for (const [sem, sessions] of Object.entries(semGroups)) {
        const docName = Object.keys(semGroups).length > 1
          ? `${timetableName} / Sem ${sem}`
          : timetableName;

        // If a Draft already exists for this sem+year, replace it
        await Timetable.deleteOne({
          name:                 { $regex: new RegExp(`Sem ${sem}.*${academicYear}`) },
          status:               'Draft',
          'studentGroup.semester': Number(sem),
        });

        const scheduleEntries = sessions.map(sessionToSchemaEntry);

        const doc = await Timetable.create({
          name: docName,
          studentGroup: {
            department: deptId,
            semester:   Number(sem),
            division:   'A',
          },
          academicYear,
          status:   'Draft',
          schedule: scheduleEntries,
        });

        savedDocs.push(doc);
        console.log(`💾 Saved timetable "${doc.name}" (${sessions.length} sessions) → ${doc._id}`);
      }

      savedDoc = savedDocs.length === 1 ? savedDocs[0] : savedDocs;
    }

    // ── 3. Respond ───────────────────────────────────────────────────────────
    res.status(200).json({
      success: true,
      message: autoSave
        ? `Timetable generated and saved successfully`
        : `Timetable generated (preview only — not saved)`,
      data: {
        timetable:   result.timetable,   // rich preview with names/labels
        savedId:     savedDoc?._id || (Array.isArray(savedDoc) ? savedDoc.map(d => d._id) : null),
        metrics:     result.metrics,
        conflicts:   result.conflicts,
        metadata:    result.metadata,
      }
    });

  } catch (error) {
    console.error('❌ Timetable generation failed:', error);
    res.status(500).json({ success: false, message: 'Failed to generate timetable', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/timetable/my-schedule
// Teacher's personal timetable — their sessions for the whole week.
// Works for: Teacher role (auto-detects from logged-in user)
//            Admin role (pass ?teacherId=xxx to view any teacher)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/my-schedule', async (req, res) => {
  try {
    // Resolve which teacher we're looking up
    let teacherDoc;

    if (req.user.role === 'admin' && req.query.teacherId) {
      // Admin viewing a specific teacher
      teacherDoc = await Teacher.findById(req.query.teacherId).populate('user', 'name email');
    } else {
      // Teacher viewing their own schedule — find Teacher record via User._id
      teacherDoc = await Teacher.findOne({ user: req.user._id }).populate('user', 'name email');
    }

    if (!teacherDoc) {
      return res.status(404).json({
        success: false,
        message: req.user.role === 'admin'
          ? 'Teacher not found'
          : 'No teacher profile found for your account. Contact admin.',
      });
    }

    // Find all Published (or Draft) timetables that contain this teacher
    const { status = 'Published', academicYear } = req.query;
    const timetableQuery = {
      status: status === 'any' ? { $in: ['Draft', 'Published'] } : status,
      'schedule.teacher': teacherDoc._id,
    };
    if (academicYear) timetableQuery.academicYear = Number(academicYear);

    const timetables = await Timetable.find(timetableQuery)
      .populate('schedule.Course', 'courseCode name courseType credits')
      .populate('schedule.teacher', 'user')
      .populate({ path: 'schedule.teacher', populate: { path: 'user', select: 'name' } })
      .populate('schedule.room', 'roomNumber floor type')
      .populate('studentGroup.department', 'name code')
      .lean();

    if (!timetables.length) {
      return res.status(200).json({
        success: true,
        message: 'No published timetable found. Ask admin to publish the timetable.',
        data: { teacher: { id: teacherDoc._id, name: teacherDoc.user?.name }, schedule: [], weeklyStats: {} }
      });
    }

    // ── Flatten all sessions belonging to this teacher ────────────────────
    const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const teacherIdStr = teacherDoc._id.toString();

    // Build day-indexed schedule
    const byDay = Object.fromEntries(DAYS.map(d => [d, []]));

    timetables.forEach(tt => {
      (tt.schedule || []).forEach(entry => {
        if (entry.teacher?._id?.toString() !== teacherIdStr &&
            entry.teacher?.toString()       !== teacherIdStr) return;

        const course = entry.Course;
        const room   = entry.room;

        const session = {
          // IDs
          timetableId:  tt._id,
          entryId:      entry._id,
          // Course info
          courseId:     course?._id,
          courseCode:   course?.courseCode,
          courseName:   course?.name,
          courseType:   course?.courseType,
          credits:      course?.credits,
          // Room info
          roomId:       room?._id,
          roomNumber:   room?.roomNumber,
          floor:        room?.floor,
          roomType:     room?.type,
          // Timing
          dayOfWeek:    entry.dayOfWeek,
          startTime:    entry.startTime,
          endTime:      entry.endTime,
          // Session metadata
          type:         entry.type,        // 'Theory' | 'Lab'
          semester:     entry.semester     || tt.studentGroup?.semester,
          division:     entry.division     || 'A',
          batch:        entry.batch        || null,
          department:   tt.studentGroup?.department?.name || tt.studentGroup?.department,
          academicYear: tt.academicYear,
        };

        if (byDay[entry.dayOfWeek]) {
          byDay[entry.dayOfWeek].push(session);
        }
      });
    });

    // Sort each day's sessions by startTime
    DAYS.forEach(day => {
      byDay[day].sort((a, b) => a.startTime.localeCompare(b.startTime));
    });

    // ── Weekly stats ─────────────────────────────────────────────────────────
    const allSessions    = Object.values(byDay).flat();
    const totalSessions  = allSessions.length;
    const theoryCount    = allSessions.filter(s => s.type === 'Theory').length;
    const labCount       = allSessions.filter(s => s.type === 'Lab').length;
    // Unique working days
    const workingDays    = new Set(allSessions.map(s => s.dayOfWeek)).size;
    // Hours = sum of (endTime - startTime) for each session
    const totalMinutes   = allSessions.reduce((acc, s) => {
      const [sh, sm] = s.startTime.split(':').map(Number);
      const [eh, em] = s.endTime.split(':').map(Number);
      return acc + (eh * 60 + em) - (sh * 60 + sm);
    }, 0);

    res.status(200).json({
      success: true,
      data: {
        teacher: {
          id:         teacherDoc._id,
          name:       teacherDoc.user?.name,
          email:      teacherDoc.user?.email,
        },
        // Full week view
        weeklySchedule: byDay,
        // Flat list (useful for mobile / list view)
        allSessions,
        // Stats card data
        weeklyStats: {
          totalSessions,
          theoryHours:  theoryCount,
          labHours:     labCount,
          workingDays,
          totalHours:   Math.round(totalMinutes / 60 * 10) / 10,
        },
      }
    });

  } catch (error) {
    console.error('❌ Error fetching teacher schedule:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch schedule', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/timetable/teachers
// Admin: list all teachers with their weekly session count (for dashboard)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/teachers', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }

    const { academicYear } = req.query;
    const query = { status: { $in: ['Draft', 'Published'] } };
    if (academicYear) query.academicYear = Number(academicYear);

    const timetables = await Timetable.find(query).lean();

    // Count sessions per teacher
    const teacherSessionCount = {};
    timetables.forEach(tt => {
      (tt.schedule || []).forEach(entry => {
        const tid = entry.teacher?.toString();
        if (!tid) return;
        if (!teacherSessionCount[tid]) teacherSessionCount[tid] = { theory: 0, lab: 0 };
        if (entry.type === 'Lab') teacherSessionCount[tid].lab++;
        else                      teacherSessionCount[tid].theory++;
      });
    });

    const teacherIds  = Object.keys(teacherSessionCount);
    const teacherDocs = await Teacher.find({ _id: { $in: teacherIds } })
      .populate('user', 'name email')
      .populate('primaryDepartment', 'name code')
      .lean();

    const result = teacherDocs.map(t => ({
      id:            t._id,
      name:          t.user?.name,
      email:         t.user?.email,
      department:    t.primaryDepartment?.name,
      theoryClasses: teacherSessionCount[t._id.toString()]?.theory || 0,
      labClasses:    teacherSessionCount[t._id.toString()]?.lab    || 0,
      totalClasses:  (teacherSessionCount[t._id.toString()]?.theory || 0) +
                     (teacherSessionCount[t._id.toString()]?.lab    || 0),
    })).sort((a, b) => b.totalClasses - a.totalClasses);

    res.status(200).json({ success: true, data: result });

  } catch (error) {
    console.error('❌ Error fetching teacher list:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch teachers', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/timetable/semesters
// ─────────────────────────────────────────────────────────────────────────────
router.get('/semesters', async (req, res) => {
  try {
    const generator = new TimetableGenerator();
    const courses   = await generator.fetchCourses();

    const semesterData = {};
    courses.forEach(course => {
      const sem = course.semester;
      if (!semesterData[sem]) {
        semesterData[sem] = { semester: sem, courses: 0, departments: new Set(), totalHours: 0 };
      }
      semesterData[sem].courses++;
      semesterData[sem].departments.add(course.department?.toString());
      semesterData[sem].totalHours += course.hoursPerWeek || course.credits || 3;
    });

    const semesterList = Object.values(semesterData).map(data => ({
      semester:     data.semester,
      courses:      data.courses,
      departments:  Array.from(data.departments),
      totalHours:   data.totalHours,
      canGenerate:  data.courses > 0,
    })).sort((a, b) => a.semester - b.semester);

    res.status(200).json({
      success: true,
      data: { semesters: semesterList, totalSemesters: semesterList.length, totalCourses: courses.length }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch semester data', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/timetable/status
// ─────────────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  try {
    const generator = new TimetableGenerator();
    const [courses, teachers, rooms] = await Promise.all([
      generator.fetchCourses(),
      generator.fetchTeachers(),
      generator.fetchRooms(),
    ]);

    res.status(200).json({
      success: true,
      data: {
        overview: {
          totalCourses:  courses.length,
          totalTeachers: teachers.length,
          totalRooms:    rooms.length,
        },
        canGenerate: courses.length > 0 && teachers.length > 0 && rooms.length > 0,
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch status', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/timetable/dashboard-stats
// ─────────────────────────────────────────────────────────────────────────────
router.get('/dashboard-stats', async (req, res) => {
  try {
    const [totalTimetables, statusBreakdown] = await Promise.all([
      Timetable.countDocuments(),
      Timetable.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])
    ]);

    const statusCounts = statusBreakdown.reduce((acc, item) => {
      acc[item._id] = item.count; return acc;
    }, {});

    res.status(200).json({
      success: true,
      data: {
        totalTimetables,
        activeTimetables: statusCounts.Published || 0,
        statusCounts: {
          Draft:     statusCounts.Draft     || 0,
          Published: statusCounts.Published || 0,
          Archived:  statusCounts.Archived  || 0,
        }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch dashboard stats', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/timetable/list
// ─────────────────────────────────────────────────────────────────────────────
router.get('/list', async (req, res) => {
  try {
    const { department, semester, status } = req.query;
    const query = {};

    if (department) {
      const dept = department.toString();
      const orConditions = [
        { 'studentGroup.department': { $regex: new RegExp(`^${dept}$`, 'i') } }
      ];
      if (/^[a-f\d]{24}$/i.test(dept)) {
        orConditions.push({ 'studentGroup.department': new mongoose.Types.ObjectId(dept) });
      }
      query.$or = orConditions;
    }
    if (semester) query['studentGroup.semester'] = Number(semester);
    if (status)   query.status = status;

    const timetables = await Timetable.find(query)
      .populate('studentGroup.department', 'name code')
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({ success: true, data: timetables });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch timetables', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/timetable/:id  — get one timetable fully populated
// ─────────────────────────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const timetable = await Timetable.findById(req.params.id)
      .populate('schedule.Course',  'courseCode name courseType credits semester')
      .populate({ path: 'schedule.teacher', populate: { path: 'user', select: 'name email' } })
      .populate('schedule.room',    'roomNumber floor type capacity')
      .populate('studentGroup.department', 'name code');

    if (!timetable) {
      return res.status(404).json({ success: false, message: 'Timetable not found' });
    }
    res.status(200).json({ success: true, data: timetable });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch timetable', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/timetable/:id/publish
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/:id/publish', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    const timetable = await Timetable.findByIdAndUpdate(
      req.params.id,
      { status: 'Published', publishedAt: new Date() },
      { new: true }
    );
    if (!timetable) return res.status(404).json({ success: false, message: 'Timetable not found' });

    res.status(200).json({ success: true, message: 'Timetable published successfully', data: timetable });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to publish timetable', error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/timetable/:id
// ─────────────────────────────────────────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin access required' });
    }
    const timetable = await Timetable.findByIdAndDelete(req.params.id);
    if (!timetable) return res.status(404).json({ success: false, message: 'Timetable not found' });

    res.status(200).json({ success: true, message: 'Timetable deleted successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to delete timetable', error: error.message });
  }
});

module.exports = router;