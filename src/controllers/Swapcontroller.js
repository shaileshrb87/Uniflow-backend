const asyncHandler = require('../middleware/asyncHandler');
const SwapRequest  = require('../models/Swaprequest');
const Timetable    = require('../models/Timetable');
const Teacher      = require('../models/Teacher');
const mongoose     = require('mongoose');

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveTeacher(userId, explicitTeacherId = null) {
  if (explicitTeacherId) {
    return Teacher.findById(explicitTeacherId).populate('user', 'name email');
  }
  return Teacher.findOne({ user: userId }).populate('user', 'name email');
}

/**
 * Find a session snapshot for a given teacher inside any Published timetable.
 * Caller provides timetableId + scheduleIndex.
 * Validates the entry actually belongs to expectedTeacherId.
 */
async function buildSessionSnapshot(timetableId, scheduleIndex, expectedTeacherId) {
  const tt = await Timetable.findById(timetableId)
    .populate('schedule.Course', 'courseCode name')
    .populate('schedule.room',   'roomNumber')
    .lean();

  if (!tt)                    throw new Error(`Timetable ${timetableId} not found`);
  if (tt.status !== 'Published') throw new Error('Can only swap sessions from a Published timetable');

  const entry = tt.schedule[scheduleIndex];
  if (!entry)                 throw new Error(`Schedule index ${scheduleIndex} not found`);

  const entryTeacherId = entry.teacher?._id?.toString() || entry.teacher?.toString();
  if (entryTeacherId !== expectedTeacherId.toString()) {
    throw new Error(`Session at index ${scheduleIndex} does not belong to the expected teacher`);
  }

  return {
    timetableId:   tt._id,
    scheduleIndex: Number(scheduleIndex),
    teacher:       entry.teacher?._id  || entry.teacher,
    course:        entry.Course?._id   || entry.Course,
    room:          entry.room?._id     || entry.room,
    dayOfWeek:     entry.dayOfWeek,
    startTime:     entry.startTime,
    endTime:       entry.endTime,
    type:          entry.type,
    semester:      entry.semester,
    division:      entry.division || 'A',
    batch:         entry.batch    || null,
    teacherName:   null,
    courseName:    entry.Course?.name       || null,
    courseCode:    entry.Course?.courseCode || null,
    roomNumber:    entry.room?.roomNumber   || null,
  };
}

/** Apply the teacher swap directly to Timetable documents */
async function applySwapToTimetable(swapReq) {
  const { fromSession, toSession } = swapReq;

  const [ttFrom, ttTo] = await Promise.all([
    Timetable.findById(fromSession.timetableId),
    Timetable.findById(toSession.timetableId),
  ]);

  if (!ttFrom) throw new Error('Source timetable not found');
  if (!ttTo)   throw new Error('Target timetable not found');

  // Swap only the teacher field — course, room, time stay the same
  ttFrom.schedule[fromSession.scheduleIndex].teacher = toSession.teacher;
  ttTo.schedule[toSession.scheduleIndex].teacher     = fromSession.teacher;

  if (ttFrom._id.equals(ttTo._id)) {
    await ttFrom.save();
  } else {
    await Promise.all([ttFrom.save(), ttTo.save()]);
  }
}

/** Check no active swap already covers one of these sessions */
async function checkConflict(fromSnap, toSnap) {
  return SwapRequest.findOne({
    status: { $in: ['pending_teacher', 'accepted', 'pending_admin'] },
    $or: [
      { 'fromSession.timetableId': fromSnap.timetableId, 'fromSession.scheduleIndex': fromSnap.scheduleIndex },
      { 'toSession.timetableId':   fromSnap.timetableId, 'toSession.scheduleIndex':   fromSnap.scheduleIndex },
      { 'fromSession.timetableId': toSnap.timetableId,   'fromSession.scheduleIndex': toSnap.scheduleIndex },
      { 'toSession.timetableId':   toSnap.timetableId,   'toSession.scheduleIndex':   toSnap.scheduleIndex },
    ],
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/swaps
// Create a lecture swap request.
//
// Body:
//   requestedToTeacherId   Teacher._id of the person being asked
//   fromTimetableId        Requester's timetable _id
//   fromScheduleIndex      Index of requester's session in schedule[]
//   toTimetableId          Target teacher's timetable _id
//   toScheduleIndex        Index of target's session in schedule[]
//   reason                 Optional note (max 500 chars)
//   requestedByTeacherId   Admin only — initiate on behalf of a teacher
//
// Cross-division example:
//   Teacher A (Div A, Math, Monday 10:20) ↔ Teacher B (Div B, English, Monday 10:20)
//   After approval: Teacher B teaches Div A Math, Teacher A teaches Div B English
// ─────────────────────────────────────────────────────────────────────────────
const createSwapRequest = asyncHandler(async (req, res) => {
  const {
    requestedByTeacherId,
    requestedToTeacherId,
    fromTimetableId,
    fromScheduleIndex,
    toTimetableId,
    toScheduleIndex,
    reason,
  } = req.body;

  // Validate required fields
  if (!requestedToTeacherId || fromTimetableId === undefined ||
      fromScheduleIndex === undefined || !toTimetableId || toScheduleIndex === undefined) {
    return res.status(400).json({
      success: false,
      error: 'Required: requestedToTeacherId, fromTimetableId, fromScheduleIndex, toTimetableId, toScheduleIndex',
    });
  }

  // Resolve requester
  const requesterTeacher = await resolveTeacher(
    req.user._id,
    req.user.role === 'admin' ? requestedByTeacherId : null
  );
  if (!requesterTeacher) {
    return res.status(404).json({ success: false, error: 'Your teacher profile was not found' });
  }

  // Resolve target
  const targetTeacher = await Teacher.findById(requestedToTeacherId).populate('user', 'name email');
  if (!targetTeacher) {
    return res.status(404).json({ success: false, error: 'Target teacher not found' });
  }
  if (requesterTeacher._id.equals(targetTeacher._id)) {
    return res.status(400).json({ success: false, error: 'Cannot swap with yourself' });
  }

  // Build snapshots — validates teacher ownership
  let fromSnapshot, toSnapshot;
  try {
    fromSnapshot = await buildSessionSnapshot(fromTimetableId, Number(fromScheduleIndex), requesterTeacher._id);
    toSnapshot   = await buildSessionSnapshot(toTimetableId,   Number(toScheduleIndex),   targetTeacher._id);
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }

  fromSnapshot.teacherName = requesterTeacher.user?.name || null;
  toSnapshot.teacherName   = targetTeacher.user?.name    || null;

  // Conflict check
  const conflict = await checkConflict(fromSnapshot, toSnapshot);
  if (conflict) {
    return res.status(409).json({
      success: false,
      error: 'One of these sessions already has a pending swap request',
      conflictId: conflict._id,
    });
  }

  const swapReq = await SwapRequest.create({
    swapType:    'lecture',
    requestedBy: requesterTeacher._id,
    requestedTo: targetTeacher._id,
    fromSession: fromSnapshot,
    toSession:   toSnapshot,
    reason:      reason || '',
    status:      'pending_teacher',
  });

  console.log(`🔄 Lecture swap request ${swapReq._id}: ${requesterTeacher.user?.name} [${fromSnapshot.division} ${fromSnapshot.courseCode}] ↔ ${targetTeacher.user?.name} [${toSnapshot.division} ${toSnapshot.courseCode}]`);

  res.status(201).json({
    success: true,
    message: `Swap request sent to ${targetTeacher.user?.name}. Waiting for their response.`,
    data:    swapReq,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/swaps/incoming
// Swap requests sent TO the logged-in teacher
// ─────────────────────────────────────────────────────────────────────────────
const getIncomingRequests = asyncHandler(async (req, res) => {
  const teacher = await resolveTeacher(req.user._id);
  if (!teacher) return res.status(404).json({ success: false, error: 'Teacher profile not found' });

  const query = {
    requestedTo: teacher._id,
    status: req.query.status || 'pending_teacher',
  };
  if (req.query.status === 'all') delete query.status;

  const requests = await SwapRequest.find(query)
    .populate({ path: 'requestedBy', populate: { path: 'user', select: 'name email' } })
    .sort({ createdAt: -1 });

  res.status(200).json({ success: true, count: requests.length, data: requests });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/swaps/outgoing
// Swap requests sent BY the logged-in teacher
// ─────────────────────────────────────────────────────────────────────────────
const getOutgoingRequests = asyncHandler(async (req, res) => {
  const teacher = await resolveTeacher(req.user._id);
  if (!teacher) return res.status(404).json({ success: false, error: 'Teacher profile not found' });

  const query = { requestedBy: teacher._id };
  if (req.query.status) query.status = req.query.status;

  const requests = await SwapRequest.find(query)
    .populate({ path: 'requestedTo', populate: { path: 'user', select: 'name email' } })
    .sort({ createdAt: -1 });

  res.status(200).json({ success: true, count: requests.length, data: requests });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/swaps/admin  — admin queue
// ─────────────────────────────────────────────────────────────────────────────
const getAdminPendingRequests = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  const { status = 'pending_admin' } = req.query;
  const query = status === 'all' ? {} : { status };

  const requests = await SwapRequest.find(query)
    .populate({ path: 'requestedBy', populate: { path: 'user', select: 'name email' } })
    .populate({ path: 'requestedTo', populate: { path: 'user', select: 'name email' } })
    .sort({ createdAt: -1 });

  res.status(200).json({ success: true, count: requests.length, data: requests });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/swaps/:id
// ─────────────────────────────────────────────────────────────────────────────
const getSwapById = asyncHandler(async (req, res) => {
  const swapReq = await SwapRequest.findById(req.params.id)
    .populate({ path: 'requestedBy', populate: { path: 'user', select: 'name email' } })
    .populate({ path: 'requestedTo', populate: { path: 'user', select: 'name email' } })
    .populate({ path: 'adminActionBy', select: 'name email' });

  if (!swapReq) return res.status(404).json({ success: false, error: 'Swap request not found' });

  if (req.user.role !== 'admin') {
    const teacher = await resolveTeacher(req.user._id);
    const isParty = teacher && (
      swapReq.requestedBy._id?.equals(teacher._id) ||
      swapReq.requestedTo._id?.equals(teacher._id)
    );
    if (!isParty) return res.status(403).json({ success: false, error: 'Access denied' });
  }

  res.status(200).json({ success: true, data: swapReq });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/swaps/:id/respond
// Target teacher accepts or rejects
// Body: { action: 'accept'|'reject', note?: '...' }
// ─────────────────────────────────────────────────────────────────────────────
const respondToSwap = asyncHandler(async (req, res) => {
  const { action, note } = req.body;
  if (!['accept', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, error: 'action must be "accept" or "reject"' });
  }

  const swapReq = await SwapRequest.findById(req.params.id);
  if (!swapReq) return res.status(404).json({ success: false, error: 'Swap request not found' });
  if (swapReq.status !== 'pending_teacher') {
    return res.status(409).json({ success: false, error: `Request is already "${swapReq.status}"` });
  }

  // Must be the target teacher (or admin)
  if (req.user.role !== 'admin') {
    const teacher = await resolveTeacher(req.user._id);
    if (!teacher || !swapReq.requestedTo.equals(teacher._id)) {
      return res.status(403).json({ success: false, error: 'Only the target teacher can respond' });
    }
  }

  swapReq.teacherRespondedAt = new Date();
  swapReq.teacherNote        = note || '';
  swapReq.status = action === 'accept' ? 'pending_admin' : 'rejected_teacher';
  await swapReq.save();

  const msg = action === 'accept'
    ? 'Swap accepted. Admin will review and finalize.'
    : 'Swap request rejected.';

  console.log(`${action === 'accept' ? '✅' : '❌'} Swap ${swapReq._id} ${action}ed by teacher`);
  res.status(200).json({ success: true, message: msg, data: swapReq });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/swaps/:id/admin-action
// Admin approves → applies swap to timetable, or rejects
// Body: { action: 'approve'|'reject', note?: '...' }
// ─────────────────────────────────────────────────────────────────────────────
const adminAction = asyncHandler(async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ success: false, error: 'Admin access required' });
  }

  const { action, note } = req.body;
  if (!['approve', 'reject'].includes(action)) {
    return res.status(400).json({ success: false, error: 'action must be "approve" or "reject"' });
  }

  const swapReq = await SwapRequest.findById(req.params.id)
    .populate({ path: 'requestedBy', populate: { path: 'user', select: 'name' } })
    .populate({ path: 'requestedTo', populate: { path: 'user', select: 'name' } });

  if (!swapReq) return res.status(404).json({ success: false, error: 'Swap request not found' });
  if (swapReq.status !== 'pending_admin') {
    return res.status(409).json({ success: false, error: `Status is "${swapReq.status}" (expected "pending_admin")` });
  }

  swapReq.adminActionBy = req.user._id;
  swapReq.adminActionAt = new Date();
  swapReq.adminNote     = note || '';

  if (action === 'reject') {
    swapReq.status = 'rejected_admin';
    await swapReq.save();
    return res.status(200).json({ success: true, message: 'Swap rejected by admin.', data: swapReq });
  }

  // Approve — apply to timetable
  try {
    await applySwapToTimetable(swapReq);
  } catch (err) {
    return res.status(500).json({ success: false, error: `Failed to update timetable: ${err.message}` });
  }

  swapReq.status        = 'approved';
  swapReq.swapAppliedAt = new Date();
  await swapReq.save();

  const nameA = swapReq.requestedBy?.user?.name || 'Teacher A';
  const nameB = swapReq.requestedTo?.user?.name || 'Teacher B';
  console.log(`✅ Admin approved swap ${swapReq._id} — ${nameA} [${swapReq.fromSession.division} ${swapReq.fromSession.courseCode}] ↔ ${nameB} [${swapReq.toSession.division} ${swapReq.toSession.courseCode}]`);

  res.status(200).json({
    success: true,
    message: `Approved. ${nameA} now teaches ${swapReq.toSession.division} ${swapReq.toSession.courseCode}, ${nameB} now teaches ${swapReq.fromSession.division} ${swapReq.fromSession.courseCode}.`,
    data: swapReq,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/swaps/:id/cancel
// ─────────────────────────────────────────────────────────────────────────────
const cancelSwapRequest = asyncHandler(async (req, res) => {
  const swapReq = await SwapRequest.findById(req.params.id);
  if (!swapReq) return res.status(404).json({ success: false, error: 'Swap request not found' });

  if (!['pending_teacher', 'pending_admin'].includes(swapReq.status)) {
    return res.status(409).json({ success: false, error: `Cannot cancel — status is "${swapReq.status}"` });
  }

  if (req.user.role !== 'admin') {
    const teacher = await resolveTeacher(req.user._id);
    if (!teacher || !swapReq.requestedBy.equals(teacher._id)) {
      return res.status(403).json({ success: false, error: 'Only the requester can cancel' });
    }
  }

  swapReq.status = 'cancelled';
  await swapReq.save();

  res.status(200).json({ success: true, message: 'Swap request cancelled.', data: swapReq });
});

// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  createSwapRequest,
  getIncomingRequests,
  getOutgoingRequests,
  getAdminPendingRequests,
  getSwapById,
  respondToSwap,
  adminAction,
  cancelSwapRequest,
};