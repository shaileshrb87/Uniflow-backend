const Course = require('../models/Course');
const Room = require('../models/Room');
const Timetable = require('../models/Timetable');
const User = require('../models/User');
const Department = require('../models/Department');
const SchedulingAlgorithm = require('./schedulingAlgorithm');
const Teacher = require('../models/Teacher');

class TimetableGenerator {
  constructor() {
    // ── Real college period schedule ──────────────────────────────────────────
    // Theory periods are 55 min each. Lab periods are 2-hour blocks.
    // Slots 1-2 are reserved for double-period lab blocks (2 hrs each).
    // Slots 3-8 are theory periods with 10-min breaks between them.
    this.theorySlots = [
      { id: 3,  startTime: '10:20', endTime: '11:15', label: '10:20 AM - 11:15 AM', type: 'theory' },
      { id: 4,  startTime: '11:15', endTime: '12:10', label: '11:15 AM - 12:10 PM', type: 'theory' },
      { id: 5,  startTime: '12:10', endTime: '13:05', label: '12:10 PM - 1:05 PM',  type: 'theory' },
      { id: 6,  startTime: '13:50', endTime: '14:45', label: '1:50 PM - 2:45 PM',   type: 'theory' },
      { id: 7,  startTime: '14:45', endTime: '15:40', label: '2:45 PM - 3:40 PM',   type: 'theory' },
      { id: 8,  startTime: '15:40', endTime: '16:35', label: '3:40 PM - 4:35 PM',   type: 'theory' }
    ];

    // Lab double-period blocks (2 hours each, before and after lunch)
    this.labSlots = [
      { id: 1,  startTime: '08:10', endTime: '10:00', label: '8:10 AM - 10:00 AM',  type: 'lab' },
      { id: 2,  startTime: '10:20', endTime: '12:10', label: '10:20 AM - 12:10 PM', type: 'lab' },
      { id: 9,  startTime: '12:50', endTime: '14:45', label: '12:50 PM - 2:45 PM',  type: 'lab' },
      { id: 10, startTime: '14:45', endTime: '16:35', label: '2:45 PM - 4:35 PM',   type: 'lab' }
    ];

    // Combined for backward-compat references
    this.timeSlots = [...this.theorySlots, ...this.labSlots];
    this.workingDays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday'];
    this.conflicts   = [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main entry point
  // ─────────────────────────────────────────────────────────────────────────────
  async generateTimetable(options = {}) {
    const {
      algorithm      = 'greedy',
      maxIterations  = 1000,
      semester       = null,
      academicYear   = new Date().getFullYear(),
      targetSemester = semester,
      departmentId   = null,
      departmentCode = null
    } = options;

    try {
      console.log('🚀 Starting timetable generation...');

      let resolvedDepartmentId = departmentId;
      if (departmentCode && !departmentId) {
        const dept = await Department.getByCode(departmentCode);
        if (dept) {
          resolvedDepartmentId = dept._id;
          console.log(`📌 Department resolved: ${departmentCode} -> ${dept.name}`);
        } else {
          throw new Error(`Department with code ${departmentCode} not found`);
        }
      }

      let courses    = await this.fetchCourses(resolvedDepartmentId);
      const teachers = await this.fetchTeachers(resolvedDepartmentId);
      const rooms    = await this.fetchRooms(resolvedDepartmentId);

      if (semester || targetSemester) {
        const targetSem = semester || targetSemester;
        courses = courses.filter(c => c.semester === targetSem);
        console.log(`📚 Filtered to semester ${targetSem}: ${courses.length} courses`);
      }

      console.log(`📊 Data loaded: ${courses.length} courses, ${teachers.length} teachers, ${rooms.length} rooms`);

      if (!teachers || teachers.length === 0) {
        throw new Error('No teachers found. Please create faculty before generating timetable.');
      }

      let timetable  = [];
      this.conflicts = [];

      switch (algorithm) {
        case 'greedy':
          timetable = await this.greedyAlgorithmImproved(courses, teachers, rooms, timetable);
          break;
        case 'genetic':
          timetable = await this.geneticAlgorithm(courses, teachers, rooms, timetable);
          break;
        case 'constraint':
          timetable = await this.constraintSatisfaction(courses, teachers, rooms, timetable);
          break;
        default:
          throw new Error(`Unknown algorithm: ${algorithm}`);
      }

      const metrics = this.calculateQualityMetrics(timetable, courses);

      console.log('✅ Timetable generation completed');
      console.log(`📈 Quality Score: ${metrics.qualityScore}/100`);
      console.log(`⚠️  Conflicts Found: ${this.conflicts.length}`);

      return {
        success: true,
        timetable,
        metrics,
        conflicts: this.conflicts,
        metadata: {
          algorithm,
          semester:    semester || targetSemester || 'all',
          academicYear,
          generatedAt: new Date().toISOString(),
          totalSessions: timetable.length
        }
      };
    } catch (error) {
      console.error('❌ Timetable generation failed:', error);
      throw error;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Greedy algorithm
  // ─────────────────────────────────────────────────────────────────────────────
  async greedyAlgorithmImproved(courses, teachers, rooms, timetable) {
    console.log('🧠 Running Improved Greedy Algorithm...');

    const sortedCourses = [...courses].sort((a, b) =>
      ((b.credits || 3) * (b.maxStudents || 30)) - ((a.credits || 3) * (a.maxStudents || 30))
    );

    const sessionsPerDay     = Object.fromEntries(this.workingDays.map(d => [d, 0]));
    const roomScheduleMap    = new Map();
    const teacherScheduleMap = new Map();

    for (const course of sortedCourses) {
      const sessionsNeeded  = course.hoursPerWeek || course.credits || 3;
      let   sessionsScheduled = 0;

      console.log(`🔄 Processing: ${course.courseCode} (${sessionsNeeded} sessions)`);

      for (let si = 0; si < sessionsNeeded; si++) {
        let scheduled = false;

        const daysByLoad = [...this.workingDays].sort((a, b) => sessionsPerDay[a] - sessionsPerDay[b]);

        for (const day of daysByLoad) {
          const avg = Object.values(sessionsPerDay).reduce((a, b) => a + b, 0) / this.workingDays.length;
          if (sessionsPerDay[day] > avg + 2) continue;

          for (const timeSlot of this.theorySlots) {
            const dayName = this.toDayName(day);

            const teacher = teachers.find(t =>
              this.canTeachCourse(t, course) &&
              this.isTeacherSlotFree(t, dayName, timeSlot.id, teacherScheduleMap)
            );
            const room = rooms.find(r =>
              this.isRoomSuitable(r, course) &&
              this.isRoomSlotFree(r, dayName, timeSlot.id, roomScheduleMap)
            );

            if (!teacher || !room) continue;

            this.reserveTeacherSlot(teacher, dayName, timeSlot.id, teacherScheduleMap);
            this.reserveRoomSlot(room,    dayName, timeSlot.id, roomScheduleMap);

            const session = this.buildScheduleEntry({
              course, teacher, room, dayOfWeek: dayName,
              timeSlot, sessionNumber: sessionsScheduled + 1
            });

            timetable.push(session);
            sessionsPerDay[day]++;
            sessionsScheduled++;
            console.log(`✅ Scheduled: ${session.courseCode} - ${dayName} ${timeSlot.label}`);
            scheduled = true;
            break;
          }
          if (scheduled) break;
        }

        if (!scheduled) {
          this.conflicts.push({
            type:    'scheduling_failed',
            course:  course.courseCode,
            reason:  'room_or_teacher_not_found',
            message: `Failed to schedule session ${si + 1} for ${course.courseName}`
          });
        }
      }
    }

    console.log('\n📊 Final Session Distribution:');
    this.workingDays.forEach(d =>
      console.log(`   ${d.charAt(0).toUpperCase() + d.slice(1)}: ${sessionsPerDay[d]} sessions`)
    );
    console.log(`\n✅ Greedy completed: ${timetable.length} sessions`);
    return timetable;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Genetic algorithm  (theory via SchedulingAlgorithm, labs via batch scheduler)
  // ─────────────────────────────────────────────────────────────────────────────
  async geneticAlgorithm(courses, teachers, rooms, timetable) {
    console.log('🧬 Running Genetic Algorithm + Batch Lab Scheduler...');

    // ── Configurable batches ────────────────────────────────────────────────────
    const BATCHES   = ['A1', 'A2', 'A3'];   // ← change here to add/remove batches
    const divisions = ['A'];

    const theoryCourses = courses.filter(
      c => c.courseType !== 'Practical' && c.courseType !== 'Lab'
    );
    const labCourses = courses.filter(
      c => c.courseType === 'Practical' || c.courseType === 'Lab'
    );

    // ── STEP 1: Schedule theory sessions via SchedulingAlgorithm ───────────────
    const sessionsToSchedule = [];
    for (const course of theoryCourses) {
      const hours = course.hoursPerWeek || course.credits || 3;
      divisions.forEach(div => {
        for (let i = 0; i < hours; i++) {
          sessionsToSchedule.push({
            courseCode:         course.courseCode,
            courseName:         course.courseName,
            courseId:           course._id,
            type:               'theory',
            division:           div,
            batch:              null,
            requiresLab:        false,
            qualifiedFaculties: course.qualifiedFaculties || []
          });
        }
      });
    }

    console.log(`📊 Sessions to schedule: ${sessionsToSchedule.length}`);
    console.log(`👨‍🏫 Teachers available:   ${teachers.length}`);

    // ── ID bridge maps ─────────────────────────────────────────────────────────
    //
    // The core problem:
    //   Course.qualifiedFaculties  →  refs 'User'  →  stores User._id values
    //   Teacher documents          →  Teacher._id  (different collection)
    //   Teacher.user               →  User._id     (the link between them)
    //
    // Solution: build a User._id → Teacher._id map using teacher.userId
    //           (which we now preserve in fetchTeachers).
    // ── ID bridge maps ─────────────────────────────────────────────────────────
    const teacherById       = new Map(teachers.map(t => [t._id.toString(), t]));
    const roomById          = new Map(rooms.map(r    => [r._id.toString(), r]));
    const userIdToTeacherId = new Map(
      teachers.filter(t => t.userId).map(t => [t.userId, t._id.toString()])
    );

    console.log(`🔑 teacherById size: ${teacherById.size}, userMap size: ${userIdToTeacherId.size}`);

    const resolveToTeacherId = (rawId) => {
      const s = rawId?.toString();
      if (!s) return null;
      if (teacherById.has(s))       return s;
      if (userIdToTeacherId.has(s)) return userIdToTeacherId.get(s);
      return null;
    };

    // ── STEP 2: Schedule THEORY via SchedulingAlgorithm ────────────────────────
    let sessionNumber = 1;

    if (sessionsToSchedule.length > 0) {
      // Use the same theory periods as defined in this.theorySlots
      // SchedulingAlgorithm generates its own slots from workingHours + timeSlotDuration.
      // We override its generated slots by passing our exact period times directly.
      const scheduler = new SchedulingAlgorithm({
        algorithm:         'genetic',
        populationSize:    100,
        maxIterations:     1000,
        breakDuration:     0,
        timeSlotDuration:  55,                       // 55-min theory periods
        workingHours:      { start: '10:20', end: '16:35' }, // theory window
        customTimeSlots:   this.theorySlots          // passed through for slot generation
      });

      const result = await scheduler.generateTimetable({
        courses: sessionsToSchedule.map(s => ({
          courseCode:         s.courseCode,
          courseName:         s.courseName,
          courseId:           s.courseId,
          department:         null,
          credits:            1,
          sessionsPerWeek:    1,
          requiresLab:        false,
          qualifiedFaculties: s.qualifiedFaculties.map(id => resolveToTeacherId(id)).filter(Boolean)
        })),
        teachers: teachers.map(t => ({ teacherId: t._id.toString(), name: t.name, department: t.primaryDepartment?.toString() ?? null })),
        rooms:    rooms.filter(r => !r.isLab).map(r => ({ roomId: r._id.toString(), roomNumber: r.roomNumber, capacity: r.capacity, isLab: false }))
      });

      console.log(`🔎 Theory scheduler: success=${result.success}, entries=${result.schedule?.length ?? 0}`);

      if (!result.success || !result.schedule || result.schedule.length === 0) {
        console.warn('⚠️  Theory scheduling failed — falling back to greedy for all');
        return this.greedyAlgorithmImproved(courses, teachers, rooms, timetable);
      }

      for (const entry of result.schedule) {
        const originalCourse  = courses.find(c => c.courseCode === entry.courseCode);
        if (!originalCourse)  { console.warn(`⚠️  Course not found: ${entry.courseCode}`);  continue; }
        const originalTeacher = teacherById.get(entry.instructor?.toString());
        if (!originalTeacher) { console.warn(`⚠️  Teacher not found: ${entry.instructor}`); continue; }
        const originalRoom    = roomById.get(entry.room?.toString());
        if (!originalRoom)    { console.warn(`⚠️  Room not found: ${entry.room}`);           continue; }
        const timeSlotObj     = this.timeSlots.find(ts => ts.startTime === entry.timeSlot?.startTime);
        if (!timeSlotObj)     { console.warn(`⚠️  TimeSlot not found: ${entry.timeSlot?.startTime}`); continue; }

        const mappedSession       = this.buildScheduleEntry({ course: originalCourse, teacher: originalTeacher, room: originalRoom, dayOfWeek: this.toDayName(entry.day), timeSlot: timeSlotObj, sessionNumber: sessionNumber++ });
        mappedSession.type        = 'theory';
        mappedSession.division    = 'A';
        mappedSession.batch       = null;
        timetable.push(mappedSession);
        console.log(`✅ Theory: ${mappedSession.courseCode} - ${mappedSession.dayOfWeek} ${timeSlotObj.label}`);
      }
    }

    // ── STEP 3: Schedule LAB sessions with batch rotation ──────────────────────
    //
    // Concept: each lab slot is a "rotation block" — all batches run simultaneously
    // but in different rooms with different teachers.
    //
    // For each lab course, we need N rotation blocks where N = hoursPerWeek.
    // In each block, every batch (A1, A2, A3) gets a unique room + teacher.
    //
    // Simultaneously in the SAME day+timeslot:
    //   A1 → Lab course X,  room R1, teacher T1
    //   A2 → Lab course X,  room R2, teacher T2
    //   A3 → Lab course X,  room R3, teacher T3
    //
    // Across the week, all batches must complete all lab courses.
    //
    if (labCourses.length > 0) {
      timetable = this.scheduleBatchLabs(labCourses, teachers, rooms, timetable, BATCHES, sessionNumber);
    }

    console.log(`✅ Genetic + Batch Lab completed: ${timetable.length} sessions generated.`);
    return timetable;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Batch Lab Scheduler
  // ─────────────────────────────────────────────────────────────────────────────
  // Each "rotation slot" = one day + one timeSlot where ALL batches run a lab
  // simultaneously (each in their own room with their own teacher).
  //
  // For each lab course, we need (hoursPerWeek) rotation slots.
  // Each rotation slot requires:
  //   - BATCHES.length available lab rooms (all free at that day+time)
  //   - BATCHES.length available qualified teachers (all free at that day+time)
  //
  // ─────────────────────────────────────────────────────────────────────────────
  // Batch Lab Scheduler — handles all lab/project types
  // ─────────────────────────────────────────────────────────────────────────────
  //
  // TYPES OF LAB COURSES:
  //
  //  1. Regular Lab (e.g. Blockchain Lab, Cloud Computing Lab)
  //     courseType = "Lab", hoursPerWeek = 2
  //     → 1 rotation block (2-hr lab slot)
  //     → All batches run simultaneously: A1 in room R1, A2 in room R2, A3 in R3
  //
  //  2. Major Project (e.g. IT805)
  //     courseType = "Lab" OR "Project", hoursPerWeek = 8
  //     → 4 rotation blocks (2-hrs each) spread across Mon–Fri
  //     → ALL batches together in ONE lab/project room (no split needed)
  //     → Needs 1 teacher/supervisor + 1 room per block
  //
  // SPREADING LOGIC:
  //     Courses are spread across different days using `usedDays` tracking.
  //     Each new lab course prefers a day not yet used by any other lab course.
  //     If all days are used, it falls back to any free slot.
  //
  scheduleBatchLabs(labCourses, teachers, rooms, timetable, batches, startSessionNumber) {
    console.log(`\n🔬 Lab Scheduler — courses: ${labCourses.map(c => c.courseCode).join(', ')} | batches: ${batches.join(', ')}`);

    const labRooms        = rooms.filter(r => r.isLab);
    const allRooms        = rooms; // project rooms may not be labs
    const roomSlotMap     = new Map();   // "roomId_Day_SlotId"    → reserved
    const teacherSlotMap  = new Map();   // "teacherId_Day_SlotId" → reserved
    const dayUsedByLab    = new Set();   // days already assigned a regular lab block

    // Pre-mark everything already scheduled (theory sessions)
    timetable.forEach(s => {
      if (s.roomId)    roomSlotMap.set(`${s.roomId}_${s.dayOfWeek}_${s.timeSlot.id}`, true);
      if (s.teacherId) teacherSlotMap.set(`${s.teacherId}_${s.dayOfWeek}_${s.timeSlot.id}`, true);
    });

    // Helper: resolve qualifiedFaculties (User._id or Teacher._id) → Teacher objects
    const resolveTeachers = (course) => {
      const ids = new Set(
        (course.qualifiedFaculties || []).map(uid => {
          const s = uid?.toString();
          const t = teachers.find(t => t.userId === s || t._id.toString() === s);
          return t ? t._id.toString() : null;
        }).filter(Boolean)
      );
      return ids.size > 0 ? teachers.filter(t => ids.has(t._id.toString())) : teachers;
    };

    // Helper: attempt to schedule ONE block on a given day+slot
    const tryScheduleBlock = (course, dayName, labSlot, isProject, sessionNumber) => {
      const candidateTeachers = resolveTeachers(course);

      if (isProject) {
        // Project: all batches share ONE room, ONE teacher (supervisor)
        // No batch splitting — the whole group works together
        const freeRoom = allRooms.find(r =>
          !roomSlotMap.has(`${r._id}_${dayName}_${labSlot.id}`)
        );
        const freeTeacher = candidateTeachers.find(t =>
          !teacherSlotMap.has(`${t._id}_${dayName}_${labSlot.id}`)
        );
        if (!freeRoom || !freeTeacher) return null;

        roomSlotMap.set(`${freeRoom._id}_${dayName}_${labSlot.id}`, true);
        teacherSlotMap.set(`${freeTeacher._id}_${dayName}_${labSlot.id}`, true);

        // For project: create one entry per batch (same room, same teacher)
        const entries = batches.map((batch, idx) => {
          const s    = this.buildScheduleEntry({ course, teacher: freeTeacher, room: freeRoom, dayOfWeek: dayName, timeSlot: labSlot, sessionNumber: sessionNumber + idx });
          s.type     = 'lab';
          s.division = 'A';
          s.batch    = batch;
          s.id       = `${course.courseCode}-${batch}-${dayName}-${labSlot.id}`;
          return s;
        });
        return entries;

      } else {
        // Regular lab: each batch needs its OWN lab room + teacher
        const freeRooms = labRooms.filter(r => !roomSlotMap.has(`${r._id}_${dayName}_${labSlot.id}`));
        const freeTeachers = candidateTeachers.filter(t => !teacherSlotMap.has(`${t._id}_${dayName}_${labSlot.id}`));

        if (freeRooms.length < batches.length) return null;
        if (freeTeachers.length === 0) return null;

        const assignedRooms    = freeRooms.slice(0, batches.length);
        // Round-robin teachers if fewer teachers than batches (e.g. 2 teachers, 3 batches)
        const assignedTeachers = batches.map((_, i) => freeTeachers[i % freeTeachers.length]);

        assignedRooms.forEach(r => roomSlotMap.set(`${r._id}_${dayName}_${labSlot.id}`, true));
        new Set(assignedTeachers.map(t => t._id.toString()))
          .forEach(tid => teacherSlotMap.set(`${tid}_${dayName}_${labSlot.id}`, true));

        const entries = batches.map((batch, idx) => {
          const s    = this.buildScheduleEntry({ course, teacher: assignedTeachers[idx], room: assignedRooms[idx], dayOfWeek: dayName, timeSlot: labSlot, sessionNumber: sessionNumber + idx });
          s.type     = 'lab';
          s.division = 'A';
          s.batch    = batch;
          s.id       = `${course.courseCode}-${batch}-${dayName}-${labSlot.id}`;
          return s;
        });
        return entries;
      }
    };

    let sessionNumber = startSessionNumber;

    for (const course of labCourses) {
      const hoursPerWeek  = course.hoursPerWeek || 2;
      const blockDuration = 2;
      const blocksNeeded  = Math.ceil(hoursPerWeek / blockDuration);

      // Detect project-type courses (8 hrs/week = major project, or courseType = Project)
      const isProject = course.courseType === 'Project' ||
                        (course.courseType === 'Lab' && hoursPerWeek >= 6);

      console.log(`\n🔬 ${course.courseCode} (${course.courseName}) | ${isProject ? 'PROJECT' : 'LAB'} | ${hoursPerWeek}h/wk → ${blocksNeeded} block(s)`);

      let blocksScheduled = 0;

      // Build a preferred day order:
      // For regular labs → prefer days NOT yet used by another lab (spread across week)
      // For projects     → any free day works (they need multiple blocks anyway)
      const preferredDays = isProject
        ? [...this.workingDays]
        : [
            ...this.workingDays.filter(d => !dayUsedByLab.has(this.toDayName(d))),
            ...this.workingDays.filter(d =>  dayUsedByLab.has(this.toDayName(d)))
          ];

      outer:
      for (const day of preferredDays) {
        if (blocksScheduled >= blocksNeeded) break;
        const dayName = this.toDayName(day);

        for (const labSlot of this.labSlots) {
          if (blocksScheduled >= blocksNeeded) break outer;

          const entries = tryScheduleBlock(course, dayName, labSlot, isProject, sessionNumber);
          if (!entries) {
            console.log(`    ⏭  ${dayName} ${labSlot.label}: no valid assignment`);
            continue;
          }

          entries.forEach(s => timetable.push(s));
          sessionNumber += entries.length;

          if (!isProject) dayUsedByLab.add(dayName); // mark this day as used for a lab block

          blocksScheduled++;
          console.log(`  ✅ Block ${blocksScheduled}/${blocksNeeded}: ${course.courseCode} [${isProject ? 'all batches' : batches.join(',')}] | ${dayName} ${labSlot.label}`);
        }
      }

      if (blocksScheduled < blocksNeeded) {
        console.warn(`  ⚠️  ${course.courseCode}: only ${blocksScheduled}/${blocksNeeded} blocks scheduled.`);
        console.warn(`       Diagnostics: lab rooms=${labRooms.length}, batches=${batches.length}, candidates=${resolveTeachers(course).length}`);
      }
    }

    return timetable;
  }

  async constraintSatisfaction(courses, teachers, rooms, timetable) {
    console.log('🔍 Running Constraint Satisfaction (greedy fallback)...');
    return this.greedyAlgorithmImproved(courses, teachers, rooms, timetable);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Data fetching
  // ─────────────────────────────────────────────────────────────────────────────

  async fetchCourses(departmentId = null) {
    try {
      const filter = {};
      if (departmentId) filter.department = departmentId;

      const courses = await Course.find(filter)
        .populate('department',         'code name')
        .populate('qualifiedFaculties', '_id')
        // NOTE: Course schema field is 'name', NOT 'courseName' — select accordingly
        .select('_id courseCode name department departmentLegacy semester courseType credits hoursPerWeek syllabus qualifiedFaculties');

      return courses.map(course => ({
        _id:              course._id,
        courseCode:       course.courseCode,
        courseName:       course.name,          // ← schema uses 'name', expose as 'courseName'
        department:       course.department?._id || course.department,
        departmentCode:   course.department?.code,
        departmentName:   course.department?.name,
        departmentLegacy: course.departmentLegacy,
        semester:         course.semester,
        courseType:       course.courseType,
        credits:          course.credits,
        hoursPerWeek:     course.hoursPerWeek,
        maxStudents:      30,
        topics:           course.syllabus?.topics || [],
        // User ObjectIds — translated to Teacher._id inside geneticAlgorithm
        qualifiedFaculties: course.qualifiedFaculties?.map(f => f._id) || []
      }));
    } catch (error) {
      console.error('Error fetching courses:', error);
      return [];
    }
  }

  async fetchTeachers(departmentId = null) {
    try {
      const filter = {};
      if (departmentId) {
        filter.$or = [
          { primaryDepartment: departmentId },
          { allowedDepartments: departmentId }
        ];
      }

      const teachers = await Teacher.find(filter)
        .populate('primaryDepartment',  'code name')
        .populate('allowedDepartments', 'code name')
        .populate('user',               '_id name email');

      return teachers.map(teacher => ({
        _id:               teacher._id,
        // CRITICAL: preserve User._id so we can bridge Course.qualifiedFaculties
        // (which stores User ObjectIds) back to Teacher documents
        userId:            teacher.user?._id?.toString() ?? null,
        name:              teacher.user?.name || teacher.name,
        primaryDepartment: teacher.primaryDepartment?._id,
        allowedDepartments: teacher.allowedDepartments?.map(d => d._id) || [],
        maxHours:          teacher.workload?.maxHoursPerWeek || 18
      }));
    } catch (error) {
      console.error('Error fetching teachers:', error);
      return [];
    }
  }

  async fetchRooms(departmentId = null) {
    try {
      const filter = { isActive: true };
      if (departmentId) filter.department = departmentId;

      const rooms = await Room.find(filter)
        .populate('department', 'code name')
        .select('_id roomNumber floor capacity type department availabilityNotes');

      return rooms.map(room => ({
        _id:               room._id,
        roomNumber:        room.roomNumber,
        capacity:          room.capacity,
        type:              room.type,
        floor:             room.floor,
        department:        room.department?._id,
        departmentCode:    room.department?.code,
        isLab:             room.type === 'laboratory',
        availabilityNotes: room.availabilityNotes
      }));
    } catch (error) {
      console.error('Error fetching rooms:', error);
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Slot reservation helpers
  // ─────────────────────────────────────────────────────────────────────────────

  toDayName(day) {
    if (!day) return 'Monday';
    const l = day.toLowerCase();
    return l.charAt(0).toUpperCase() + l.slice(1);
  }

  isTeacherSlotFree(teacher, day, slotId, map) { return !map.has(`${teacher._id}_${day}_${slotId}`); }
  reserveTeacherSlot(teacher, day, slotId, map) { map.set(`${teacher._id}_${day}_${slotId}`, true); }
  isRoomSlotFree(room, day, slotId, map)        { return !map.has(`${room._id}_${day}_${slotId}`); }
  reserveRoomSlot(room, day, slotId, map)        { map.set(`${room._id}_${day}_${slotId}`, true); }

  // Used by greedy — qualifiedFaculties stores User._id, so compare via teacher.userId
  canTeachCourse(teacher, course) {
    if (course.qualifiedFaculties?.length > 0) {
      const qualifiedUserIds = course.qualifiedFaculties.map(id => id.toString());
      if (teacher.userId && qualifiedUserIds.includes(teacher.userId)) return true;
    }
    if (teacher.primaryDepartment && course.department) {
      if (teacher.primaryDepartment.toString() === course.department.toString()) return true;
      return teacher.allowedDepartments?.some(
        d => d.toString() === course.department.toString()
      ) ?? false;
    }
    return false;
  }

  isRoomSuitable(room, course) {
    if (room.capacity < (course.maxStudents || 30)) return false;
    if (course.courseType === 'Practical' || course.courseType === 'Lab') return room.type === 'laboratory';
    if (course.courseType === 'Theory')   return ['classroom', 'lecture_hall', 'seminar_room'].includes(room.type);
    if (course.courseType === 'Tutorial') return ['classroom', 'seminar_room'].includes(room.type) && room.capacity <= 40;
    return true;
  }

  buildScheduleEntry({ course, teacher, room, dayOfWeek, timeSlot, sessionNumber }) {
    return {
      id:          `${course.courseCode}-${dayOfWeek}-${timeSlot.id}-${sessionNumber}`,
      course:      course._id,
      subject:     course._id,
      courseCode:  course.courseCode,
      courseName:  course.courseName,
      teacher:     teacher._id,
      teacherId:   teacher._id,
      teacherName: teacher.name,
      room:        room._id,
      roomId:      room._id,
      roomNumber:  room.roomNumber,
      dayOfWeek,
      timeSlot: {
        id:        timeSlot.id,
        startTime: timeSlot.startTime,
        endTime:   timeSlot.endTime,
        label:     timeSlot.label
      },
      startTime:   timeSlot.startTime,
      endTime:     timeSlot.endTime,
      semester:    course.semester,
      department:  course.department,
      courseType:  course.courseType,
      credits:     course.credits,
      maxStudents: course.maxStudents || 30,
      courseMeta: {
        code:       course.courseCode,
        name:       course.courseName,
        department: course.department,
        credits:    course.credits,
        duration:   course.hoursPerWeek
      }
    };
  }

  calculateQualityMetrics(timetable, courses) {
    const scheduled     = new Set(timetable.map(s => s.courseCode)).size;
    const total         = courses.length;
    const schedulingRate = total > 0 ? (scheduled / total) * 100 : 0;
    const qualityScore   = Math.max(0, schedulingRate - this.conflicts.length * 5);
    return {
      qualityScore:     Math.round(qualityScore),
      schedulingRate:   Math.round(schedulingRate),
      totalSessions:    timetable.length,
      totalConflicts:   this.conflicts.length,
      coursesScheduled: scheduled,
      totalCourses:     total
    };
  }

  validateTimetable(timetable) {
    const conflicts   = [];
    const teacherSched = {};
    const roomSched    = {};
    timetable.forEach(s => {
      const tk = `${s.teacherId}-${s.dayOfWeek}-${s.timeSlot.id}`;
      if (teacherSched[tk]) conflicts.push({ type: 'teacher_conflict', teacher: s.teacherName, sessions: [teacherSched[tk], s] });
      teacherSched[tk] = s;
      const rk = `${s.roomId}-${s.dayOfWeek}-${s.timeSlot.id}`;
      if (roomSched[rk]) conflicts.push({ type: 'room_conflict', room: s.roomNumber, sessions: [roomSched[rk], s] });
      roomSched[rk] = s;
    });
    return conflicts;
  }
}

module.exports = TimetableGenerator;