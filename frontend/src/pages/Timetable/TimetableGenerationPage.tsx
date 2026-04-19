// pages/TimetableGenerationPage.tsx
//
// ── WHAT THIS FILE DOES ──────────────────────────────────────────────────────
// Replaces the old 4-step flow that required manual teacher assignment.
// The backend TimetableGenerator (v2) auto-extracts teachers from
// Course.qualifiedFaculties — so the UI only needs:
//   1. Semester(s) to generate
//   2. Division(s)
//   3. Department
//   4. Academic year
// Then it calls POST /api/timetable/generate and displays the result grid.
// ─────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import {
  Zap, ArrowLeft, AlertCircle, BookOpen, FlaskConical, Building2,
  Calendar, Clock3, Users2, Layers, GraduationCap, X, Loader2, CheckCircle2,
  ChevronDown, Info
} from 'lucide-react';

const API = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5000/api';

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────
interface Session {
  id:          string;
  courseCode:  string;
  courseName:  string;
  teacherName: string;
  roomNumber:  string;
  dayOfWeek:   string;
  startTime:   string;
  endTime:     string;
  type:        'theory' | 'lab';
  division:    string;
  batch:       string | null;
  semester:    number | string;
  credits:     number;
  timeSlot?:   { id: number; label: string };
}

interface GenerateResult {
  division:  string;
  semester:  number | string;
  timetable: Session[];
  metrics:   {
    qualityScore:      number;
    schedulingRate:    number;
    totalSessions:     number;
    coursesScheduled:  number;
    totalCourses:      number;
    totalConflicts:    number;
  };
}

interface Conflict {
  type:    string;
  course?: string;
  batch?:  string;
  message: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS — matches TimetableGenerator exactly
// ─────────────────────────────────────────────────────────────────────────────
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

const ALL_SLOTS = [
  { id: 1,  start: '08:10', end: '10:00', label: '8:10–10:00',  type: 'lab'    },
  { id: 3,  start: '10:20', end: '11:15', label: '10:20–11:15', type: 'theory' },
  { id: 4,  start: '11:15', end: '12:10', label: '11:15–12:10', type: 'theory' },
  { id: 5,  start: '12:10', end: '13:05', label: '12:10–1:05',  type: 'theory' },
  { id: 6,  start: '13:50', end: '14:45', label: '1:50–2:45',   type: 'theory' },
  { id: 7,  start: '14:45', end: '15:40', label: '2:45–3:40',   type: 'theory' },
  { id: 8,  start: '15:40', end: '16:35', label: '3:40–4:35',   type: 'theory' },
  { id: 9,  start: '12:50', end: '14:45', label: '12:50–2:45',  type: 'lab'    },
];

const PALETTE = [
  { bg: '#EFF6FF', border: '#3B82F6', text: '#1D4ED8', badge: '#DBEAFE' },
  { bg: '#F0FDF4', border: '#22C55E', text: '#15803D', badge: '#DCFCE7' },
  { bg: '#FDF4FF', border: '#A855F7', text: '#7E22CE', badge: '#F3E8FF' },
  { bg: '#FFF7ED', border: '#F97316', text: '#C2410C', badge: '#FFEDD5' },
  { bg: '#FFF1F2', border: '#F43F5E', text: '#BE123C', badge: '#FFE4E6' },
  { bg: '#F0FDFA', border: '#14B8A6', text: '#0F766E', badge: '#CCFBF1' },
  { bg: '#FFFBEB', border: '#EAB308', text: '#A16207', badge: '#FEF9C3' },
  { bg: '#F5F3FF', border: '#8B5CF6', text: '#6D28D9', badge: '#F3E8FF' },
];
const colorCache: Record<string, typeof PALETTE[0]> = {};
let ci = 0;
const courseColor = (code: string) => {
  if (!colorCache[code]) colorCache[code] = PALETTE[ci++ % PALETTE.length];
  return colorCache[code];
};

const toMin = (t: string) => {
  const [h, m] = (t || '0:0').split(':').map(Number);
  return h * 60 + m;
};

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE
// ─────────────────────────────────────────────────────────────────────────────
const TimetableGenerationPage: React.FC = () => {
  const navigate = useNavigate();

  // ── Config ────────────────────────────────────────────────────────────────
  const [semesters,  setSemesters]  = useState<number[]>([8]);
  const [divisions,  setDivisions]  = useState<string[]>(['A']);
  const [dept,       setDept]       = useState('Information Technology');
  const [year,       setYear]       = useState(new Date().getFullYear());
  const [algo,       setAlgo]       = useState<'genetic' | 'greedy'>('genetic');

  // ── Status ────────────────────────────────────────────────────────────────
  const [status,     setStatus]     = useState<{ courses: number; teachers: number; rooms: number } | null>(null);
  const [phase,      setPhase]      = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [log,        setLog]        = useState<string[]>([]);
  const [errMsg,     setErrMsg]     = useState('');

  // ── Results ───────────────────────────────────────────────────────────────
  const [results,    setResults]    = useState<GenerateResult[]>([]);
  const [savedIds,   setSavedIds]   = useState<Record<string, string>>({});
  const [conflicts,  setConflicts]  = useState<Conflict[]>([]);
  const [activeDiv,  setActiveDiv]  = useState('');
  const [saveState,  setSaveState]  = useState<Record<string, 'idle' | 'saving' | 'saved' | 'error'>>({});

  // ── Drag state ────────────────────────────────────────────────────────────
  const [dragSrc,    setDragSrc]    = useState<{ session: Session; fromDay: string; fromStart: string } | null>(null);
  const [dropOver,   setDropOver]   = useState<{ day: string; start: string } | null>(null);

  // ── Detail modal ──────────────────────────────────────────────────────────
  const [modal,      setModal]      = useState<Session | null>(null);

  // ── Toast ─────────────────────────────────────────────────────────────────
  const [toast,      setToast]      = useState<{ msg: string; ok: boolean } | null>(null);

  const logRef = useRef<HTMLDivElement>(null);

  const flash = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 3200);
  };

  const addLog = (m: string) => setLog(p => [...p, m]);

  // Auto-scroll log
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [log]);

  // Load system status on mount
  useEffect(() => {
    const load = async () => {
      try {
        const res = await axios.get(`${API}/timetable/status`);
        setStatus(res.data.data?.overview || null);
      } catch { /* ignore */ }
    };
    load();
  }, []);

  // ── Toggle helpers ────────────────────────────────────────────────────────
  const toggleSem = (n: number) =>
    setSemesters(p => p.includes(n) ? p.filter(x => x !== n) : [...p, n].sort());
  const toggleDiv = (d: string) =>
    setDivisions(p => p.includes(d) ? p.filter(x => x !== d) : [...p, d].sort());

  // ── GENERATE ──────────────────────────────────────────────────────────────
  const generate = async () => {
    if (!semesters.length || !divisions.length) {
      flash('Select at least one semester and division', false);
      return;
    }

    setPhase('running');
    setLog([]);
    setResults([]);
    setConflicts([]);

    addLog('🔌 Connecting to UniFlow backend…');
    await tick(200);
    addLog(`📚 Loading Semester ${semesters.join(', ')} courses…`);
    await tick(350);
    addLog(`👥 Teachers auto-resolved from Course.qualifiedFaculties…`);
    await tick(300);
    addLog(`🏫 Loading rooms…`);
    await tick(250);
    addLog(`⚙️  Running ${algo === 'genetic' ? 'Genetic' : 'Greedy'} algorithm…`);
    addLog(`📐 ScheduleTracker: time-range overlap detection active…`);

    try {
      const token = localStorage.getItem('token');
      const res = await axios.post(
        `${API}/timetable/generate`,
        {
          semesters,
          divisions,
          departmentId: dept,
          academicYear: year,
          algorithm:    algo,
          autoSave:     true,
          respectExisting: true,
        },
        { headers: { Authorization: token ? `Bearer ${token}` : '' } }
      );

      const data = res.data;
      if (!data.success) throw new Error(data.message || 'Generation failed');

      const apiResults: GenerateResult[] = data.data?.results || [];
      const apiSaved   = data.data?.saved    || [];
      const apiConflicts: Conflict[] = data.data?.conflicts || [];

      const total = apiResults.reduce((a: number, r: GenerateResult) => a + r.timetable.length, 0);
      addLog(`✅ Complete — ${total} sessions across ${apiResults.length} timetable(s)`);
      if (apiConflicts.length) addLog(`⚠️  ${apiConflicts.length} conflict(s) (see panel below)`);
      else addLog(`✓ Zero clashes detected`);

      // Build savedIds map: division → doc _id
      const ids: Record<string, string> = {};
      apiSaved.forEach((s: any) => { ids[s.division] = s.id; });

      setResults(apiResults);
      setSavedIds(ids);
      setConflicts(apiConflicts);
      setActiveDiv(apiResults[0]?.division || divisions[0]);
      setPhase('done');
      flash(`Generated ${apiResults.length} timetable(s) — ${total} sessions`);
    } catch (err: any) {
      const msg = err.response?.data?.message || err.message || 'Unknown error';
      addLog(`❌ Error: ${msg}`);
      setErrMsg(msg);
      setPhase('error');
      flash(msg, false);
    }
  };

  // ── PUBLISH ───────────────────────────────────────────────────────────────
  const publish = async (div: string) => {
    const id = savedIds[div];
    if (!id) return flash('No saved ID — generate first', false);
    setSaveState(p => ({ ...p, [div]: 'saving' }));
    try {
      const token = localStorage.getItem('token');
      await axios.patch(`${API}/timetable/${id}/publish`, {}, {
        headers: { Authorization: token ? `Bearer ${token}` : '' }
      });
      setSaveState(p => ({ ...p, [div]: 'saved' }));
      flash(`Div ${div} published ✓`);
    } catch (err: any) {
      setSaveState(p => ({ ...p, [div]: 'error' }));
      flash(err.response?.data?.message || err.message, false);
    }
  };

  // ── DRAG & DROP ───────────────────────────────────────────────────────────
  const onDragStart = (session: Session, day: string, start: string) =>
    setDragSrc({ session, fromDay: day, fromStart: start });

  const onDrop = (toDay: string, toStart: string) => {
    setDropOver(null);
    if (!dragSrc) return;
    const { session, fromDay, fromStart } = dragSrc;
    setDragSrc(null);
    if (toDay === fromDay && toStart === fromStart) return;

    const toSlot = ALL_SLOTS.find(s => s.start === toStart);
    if (!toSlot) return;
    if (session.type === 'theory' && toSlot.type === 'lab')
      return flash('Cannot move theory → lab slot', false);
    if (session.type === 'lab' && toSlot.type === 'theory')
      return flash('Cannot move lab → theory slot', false);

    setResults(prev => prev.map(r => {
      if (r.division !== activeDiv) return r;
      return {
        ...r,
        timetable: r.timetable.map(s =>
          s.id === session.id
            ? { ...s, dayOfWeek: toDay, startTime: toSlot.start, endTime: toSlot.end,
                timeSlot: { id: toSlot.id, label: toSlot.label } }
            : s
        ),
      };
    }));
    flash(`Moved ${session.courseCode} → ${toDay} ${toSlot.label}`);
  };

  // ── Current division data ─────────────────────────────────────────────────
  const activeSessions: Session[] = results.find(r => r.division === activeDiv)?.timetable || [];
  const activeMetrics = results.find(r => r.division === activeDiv)?.metrics;

  // Slots that have data OR are theory (always visible)
  const usedStarts = new Set(activeSessions.map(s => s.startTime));
  const visSlots = ALL_SLOTS.filter(sl => sl.type === 'theory' || usedStarts.has(sl.start));

  // Build grid
  const grid: Record<string, Record<string, Session[]>> = {};
  DAYS.forEach(d => { grid[d] = {}; });
  activeSessions.forEach(s => {
    if (!grid[s.dayOfWeek]) grid[s.dayOfWeek] = {};
    if (!grid[s.dayOfWeek][s.startTime]) grid[s.dayOfWeek][s.startTime] = [];
    grid[s.dayOfWeek][s.startTime].push(s);
  });

  return (
    <div style={P.root}>
      <style>{CSS}</style>

      {/* Toast */}
      {toast && (
        <div style={{ ...P.toast, background: toast.ok ? '#052e1a' : '#1a0505', borderColor: toast.ok ? '#16a34a' : '#b91c1c', color: toast.ok ? '#86efac' : '#fca5a5' }}>
          {toast.ok ? '✓ ' : '✕ '}{toast.msg}
        </div>
      )}

      {/* ── HEADER ── */}
      <header style={P.header}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={P.brandMark}>UF</div>
          <div>
            <div style={P.brandName}>Timetable Generation</div>
            <div style={P.brandSub}>UniFlow · Auto-assigns teachers from course qualifications</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          {phase === 'done' && (
            <button style={P.btnGhost} onClick={() => { setPhase('idle'); setResults([]); setLog([]); }}>
              ← Regenerate
            </button>
          )}
          <button style={P.btnGhost} onClick={() => navigate('/timetable')}>View All →</button>
        </div>
      </header>

      {/* ── STATUS BAR ── */}
      {status && (
        <div style={P.statusBar}>
          {[['Courses', status.courses], ['Teachers', status.teachers], ['Rooms', status.rooms]].map(([k, v]) => (
            <span key={k as string} style={P.statusChip}>
              <span style={{ color: '#2563eb', fontWeight: 800 }}>{v}</span>
              <span style={{ color: '#374151', marginLeft: 4 }}>{k} loaded</span>
            </span>
          ))}
          <span style={{ ...P.statusChip, color: '#16a34a' }}>✓ Teachers auto-resolved</span>
        </div>
      )}

      <div style={P.body}>
        {/* ════════════════════════════════════════════════
            CONFIG PANEL  (always visible on left / top)
        ════════════════════════════════════════════════ */}
        <aside style={P.configPanel} className="config-panel">
          <div style={P.configTitle}>Configure</div>

          {/* Semester */}
          <div style={P.fieldGroup}>
            <div style={P.fieldLabel}>SEMESTER(S)</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 7 }}>
              {[1,2,3,4,5,6,7,8].map(n => (
                <button key={n} style={{ ...P.togBtn, ...(semesters.includes(n) ? P.togActive : {}) }} onClick={() => toggleSem(n)}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          {/* Divisions */}
          <div style={P.fieldGroup}>
            <div style={P.fieldLabel}>DIVISION(S)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {['A','B','C','D'].map(d => (
                <button key={d} style={{ ...P.divBtn, ...(divisions.includes(d) ? P.togActive : {}) }} onClick={() => toggleDiv(d)}>
                  {d}
                </button>
              ))}
            </div>
          </div>

          {/* Department */}
          <div style={P.fieldGroup}>
            <div style={P.fieldLabel}>DEPARTMENT</div>
            <input style={P.input} value={dept} onChange={e => setDept(e.target.value)} placeholder="e.g. Information Technology" />
          </div>

          {/* Year */}
          <div style={P.fieldGroup}>
            <div style={P.fieldLabel}>ACADEMIC YEAR</div>
            <input style={P.input} type="number" value={year} onChange={e => setYear(Number(e.target.value))} />
          </div>

          {/* Algorithm */}
          <div style={P.fieldGroup}>
            <div style={P.fieldLabel}>ALGORITHM</div>
            <div style={{ display: 'flex', gap: 8 }}>
              {(['genetic','greedy'] as const).map(a => (
                <button key={a} style={{ ...P.algoBtn, ...(algo === a ? P.togActive : {}) }} onClick={() => setAlgo(a)}>
                  {a === 'genetic' ? '🧬 Genetic' : '⚡ Greedy'}
                </button>
              ))}
            </div>
          </div>

          {/* Info note */}
          <div style={P.infoNote}>
            ℹ️ No manual teacher assignment needed. Teachers are auto-selected from each course's field with load balancing.
          </div>

          {/* Summary */}
          <div style={P.summaryRow}>
            {[['Sems', semesters.join(',') || '–'],['Divs', divisions.join(',') || '–'],['Batches', String(divisions.length*3)]].map(([k,v]) => (
              <div key={k} style={P.summaryCell}>
                <span style={P.summaryK}>{k}</span>
                <span style={P.summaryV}>{v}</span>
              </div>
            ))}
          </div>

          {/* Generate Button */}
          <button
            style={{ ...P.btnGenerate, ...(phase === 'running' || !semesters.length || !divisions.length ? P.btnDisabled : {}) }}
            onClick={generate}
            disabled={phase === 'running' || !semesters.length || !divisions.length}
            className="generate-btn"
          >
            {phase === 'running' ? (
              <><div className="spin-sm" />Generating…</>
            ) : (
              <>⚡ Generate Timetable</>
            )}
          </button>
        </aside>

        {/* ════════════════════════════════════════════════
            RIGHT PANEL
        ════════════════════════════════════════════════ */}
        <div style={P.rightPanel}>

          {/* ── IDLE STATE ── */}
          {phase === 'idle' && (
            <div style={P.emptyState}>
              <div style={P.emptyIcon}>📅</div>
              <div style={P.emptyTitle}>Ready to Generate</div>
              <div style={P.emptySub}>Configure parameters on the left, then click Generate. Teachers are assigned automatically — no manual steps required.</div>
            </div>
          )}

          {/* ── LOG / RUNNING ── */}
          {(phase === 'running' || phase === 'error') && (
            <div style={P.logCard} className="fade-in">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                {phase === 'running' && <div className="spin-lg" />}
                {phase === 'error'   && <span style={{ fontSize: 24 }}>❌</span>}
                <div style={{ fontSize: 16, fontWeight: 800, color: '#e2eaf4' }}>
                  {phase === 'running' ? 'Generating…' : 'Generation Failed'}
                </div>
              </div>
              <div ref={logRef} style={P.logBox}>
                {log.map((l, i) => (
                  <div key={i} style={{ ...P.logLine, opacity: i === log.length-1 ? 1 : 0.4, fontWeight: i === log.length-1 ? 600 : 400 }}>
                    {l}
                  </div>
                ))}
              </div>
              {phase === 'error' && errMsg && (
                <div style={{ marginTop: 16, background: '#1a0505', border: '1px solid #7f1d1d', color: '#f87171', padding: '12px 14px', borderRadius: 8, fontSize: 13 }}>
                  {errMsg}
                </div>
              )}
            </div>
          )}

          {/* ── DONE — RESULTS ── */}
          {phase === 'done' && (
            <div className="fade-in" style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%' }}>

              {/* Top bar */}
              <div style={P.resultTopbar}>
                {/* Division tabs */}
                <div style={{ display: 'flex', gap: 8 }}>
                  {results.map(r => (
                    <button
                      key={r.division}
                      style={{ ...P.divTab, ...(activeDiv === r.division ? P.divTabActive : {}) }}
                      onClick={() => setActiveDiv(r.division)}
                    >
                      <span style={{ fontSize: 15, fontWeight: 900, color: activeDiv === r.division ? '#60a5fa' : '#3d5470' }}>
                        {r.division}
                      </span>
                      <span style={{ fontSize: 9, color: activeDiv === r.division ? '#3b82f6' : '#1e3050' }}>
                        {r.timetable.length} sessions
                      </span>
                    </button>
                  ))}
                </div>

                {/* Metrics + publish */}
                <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: 'auto' }}>
                  {activeMetrics && (
                    <>
                      <div style={P.metricChip}>{activeMetrics.qualityScore}/100 <span style={{ opacity: 0.5 }}>score</span></div>
                      <div style={{ ...P.metricChip, background: '#052e1a', borderColor: '#16a34a', color: '#86efac' }}>
                        {activeMetrics.coursesScheduled}/{activeMetrics.totalCourses} <span style={{ opacity: 0.5 }}>courses</span>
                      </div>
                    </>
                  )}
                  <button
                    style={{ ...P.btnPublish, ...(saveState[activeDiv] === 'saved' ? P.btnPublished : {}) }}
                    onClick={() => publish(activeDiv)}
                    disabled={saveState[activeDiv] === 'saving'}
                  >
                    {saveState[activeDiv] === 'saving' ? '…' : saveState[activeDiv] === 'saved' ? '✓ Published' : '🚀 Publish'}
                  </button>
                </div>
              </div>

              {/* Conflicts */}
              {conflicts.length > 0 && (
                <div style={P.conflictBanner}>
                  <span style={{ color: '#f59e0b', fontWeight: 700, marginRight: 8 }}>⚠ {conflicts.length} conflict(s)</span>
                  {conflicts.slice(0, 2).map((c, i) => <span key={i} style={{ fontSize: 11, color: '#78716c', marginRight: 10 }}>{c.message}</span>)}
                  {conflicts.length > 2 && <span style={{ fontSize: 11, color: '#78716c' }}>+{conflicts.length-2} more</span>}
                </div>
              )}

              {/* Log output collapsed */}
              <details style={{ padding: '6px 16px', borderBottom: '1px solid #0a0f1a' }}>
                <summary style={{ fontSize: 10, color: '#1e3050', cursor: 'pointer', letterSpacing: 1, fontWeight: 700 }}>GENERATION LOG</summary>
                <div style={{ ...P.logBox, maxHeight: 120, marginTop: 8 }}>
                  {log.map((l, i) => <div key={i} style={{ ...P.logLine, opacity: 0.5 }}>{l}</div>)}
                </div>
              </details>

              {/* ── TIMETABLE GRID ── */}
              <div style={{ flex: 1, overflowX: 'auto', overflowY: 'auto' }}>
                <table style={P.table}>
                  <thead>
                    <tr>
                      <th style={P.thTime}>TIME</th>
                      {DAYS.map(d => (
                        <th key={d} style={P.th}>
                          <div>{d.slice(0,3).toUpperCase()}</div>
                          <div style={{ fontSize: 8, fontWeight: 400, color: '#1e3050', letterSpacing: 1 }}>{d.slice(3)}</div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visSlots.map(slot => (
                      <tr key={slot.id}>
                        <td style={P.tdTime}>
                          <div style={P.timeLabel}>{slot.label}</div>
                          <span style={{ ...P.slotBadge, background: slot.type === 'lab' ? '#2d1800' : '#0d1e38', color: slot.type === 'lab' ? '#f59e0b' : '#2563eb' }}>
                            {slot.type}
                          </span>
                        </td>
                        {DAYS.map(day => {
                          const cells = grid[day]?.[slot.start] || [];
                          const isOver = dropOver?.day === day && dropOver?.start === slot.start;
                          return (
                            <td
                              key={day}
                              style={{ ...P.td, ...(isOver ? P.tdOver : {}) }}
                              onDragOver={e => { e.preventDefault(); setDropOver({ day, start: slot.start }); }}
                              onDragLeave={() => setDropOver(null)}
                              onDrop={() => onDrop(day, slot.start)}
                            >
                              {cells.length === 0 && !isOver && <div style={{ height: 52 }} />}
                              {cells.length === 0 && isOver && <div style={P.dropHint}>Drop here</div>}
                              {cells.map(session => (
                                <SessionCard
                                  key={session.id}
                                  session={session}
                                  onDragStart={() => onDragStart(session, day, slot.start)}
                                  onClick={() => setModal(session)}
                                />
                              ))}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── DETAIL MODAL ── */}
      {modal && <DetailModal session={modal} onClose={() => setModal(null)} />}
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// SESSION CARD
// ─────────────────────────────────────────────────────────────────────────────
const SessionCard: React.FC<{ session: Session; onDragStart: () => void; onClick: () => void }> = ({ session, onDragStart, onClick }) => {
  const c    = courseColor(session.courseCode);
  const isLab = session.type === 'lab';
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className="tt-card"
      aria-label={`Session: ${session.courseCode} - ${session.courseName}. Teacher: ${session.teacherName}. Room: ${session.roomNumber}. Type: ${session.type}`}
      title={`${session.courseCode}: ${session.courseName}\nTeacher: ${session.teacherName}\nRoom: ${session.roomNumber}`}
      style={{ 
        background: c.bg, 
        borderLeft: `3px solid ${c.border}`,
        border: `1px solid ${c.border}30`,
        borderLeftWidth: 3,
        borderLeftColor: c.border,
        borderRadius: 8, 
        padding: '8px 10px', 
        marginBottom: 4, 
        cursor: 'grab', 
        userSelect: 'none',
        width: '100%',
        textAlign: 'left',
        display: 'block',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
        <span style={{ fontSize: 11, fontWeight: 800, color: c.text, fontFamily: "'DM Mono', monospace", letterSpacing: '-.2px', minWidth: 0 }}>
          {session.courseCode}
        </span>
        <span style={{ fontSize: 8, fontWeight: 700, background: c.badge, color: c.text, padding: '2px 8px', borderRadius: 99, whiteSpace: 'nowrap', flexShrink: 0, textTransform: 'uppercase', letterSpacing: '.2px' }}>
          {isLab ? '🧪' : '📖'} {session.type.toUpperCase()}{session.batch ? ` · ${session.batch}` : ''}
        </span>
      </div>
      <div style={{ fontSize: 10, color: '#374151', marginTop: 4, lineHeight: 1.3, fontWeight: 500 }}>
        {session.courseName && session.courseName.length > 26 ? session.courseName.slice(0, 26) + '…' : session.courseName}
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 5, fontSize: 9, color: '#6B7280' }}>
        <span>👤 {(session.teacherName || 'N/A').split(' ')[0]}</span>
        {session.roomNumber && <span>🚪 {session.roomNumber}</span>}
      </div>
    </button>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// DETAIL MODAL
// ─────────────────────────────────────────────────────────────────────────────
const DetailModal: React.FC<{ session: Session; onClose: () => void }> = ({ session, onClose }) => {
  const c = courseColor(session.courseCode);
  const isLab = session.type === 'lab';

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.5)', backdropFilter: 'blur(6px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20, animation: 'backdropIn 0.25s ease-out' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        style={{ background: '#fff', borderRadius: 20, padding: 28, maxWidth: 480, width: '100%', boxShadow: '0 32px 80px rgba(0,0,0,.2)', border: `1px solid ${c.border}20`, animation: 'modalSlideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1)' }}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onKeyDown={handleKeyDown}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <div style={{ background: '#F3F4F6', borderRadius: 8, width: 44, height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {isLab ? <FlaskConical size={20} color={c.text} /> : <BookOpen size={20} color={c.text} />}
            </div>
            <div>
              <div id="modal-title" style={{ fontSize: 11, fontWeight: 700, color: c.text, fontFamily: "'DM Mono', monospace", letterSpacing: '.5px', textTransform: 'uppercase' }}>{session.courseCode}</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: '#111827', marginTop: 1, lineHeight: 1.2, maxWidth: 300 }}>{session.courseName}</div>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close session details"
            className="modal-close-btn"
            style={{ background: '#F3F4F6', border: 'none', borderRadius: 7, width: 30, height: 30, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#6B7280', flexShrink: 0, transition: 'all 0.2s', fontSize: 18 }}
          >
            <X size={16} />
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 12 }}>
          {[
            { icon: <GraduationCap size={14} />, label: 'Teacher', val: session.teacherName || 'Not assigned' },
            { icon: <Building2 size={14} />, label: 'Room', val: session.roomNumber || 'Not assigned' },
            { icon: <Calendar size={14} />, label: 'Day', val: session.dayOfWeek },
            { icon: <Clock3 size={14} />, label: 'Time', val: `${session.startTime} – ${session.endTime}` },
            { icon: <Users2 size={14} />, label: 'Division', val: `Div ${session.division}${session.batch ? ` · Batch ${session.batch}` : ''}` },
            { icon: <Layers size={14} />, label: 'Semester', val: `Semester ${session.semester}` },
          ].map(({ icon, label, val }) => (
            <div key={label} style={{ background: '#F9FAFB', borderRadius: 8, padding: '10px 12px', border: '1px solid #F3F4F6' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#94A3B8', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.5px', marginBottom: 3 }}>{icon}{label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: '#111827' }}>{val}</div>
            </div>
          ))}
        </div>
        <div style={{ padding: '11px 13px', background: c.bg, borderRadius: 8, border: `1px solid ${c.border}40`, display: 'flex', alignItems: 'center', gap: 7 }}>
          {isLab ? <FlaskConical size={15} color={c.text} /> : <BookOpen size={15} color={c.text} />}
          <span style={{ fontSize: 12, fontWeight: 700, color: c.text }}>{isLab ? 'Laboratory Session' : 'Theory Lecture'}</span>
          {session.credits && <span style={{ marginLeft: 'auto', fontSize: 11, color: c.text, opacity: .7 }}>{session.credits} credits</span>}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────────────────────
const P: Record<string, React.CSSProperties> = {
  root:        { minHeight: '100vh', background: '#F8FAFC', color: '#1F2937', fontFamily: "'Outfit','DM Sans',system-ui,sans-serif", display: 'flex', flexDirection: 'column' },
  header:      { position: 'sticky', top: 0, zIndex: 50, background: '#FFF', backdropFilter: 'blur(12px)', borderBottom: '1px solid #E5E7EB', padding: '16px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', boxShadow: '0 1px 2px rgba(0,0,0,.03)' },
  brandMark:   { width: 40, height: 40, borderRadius: 10, background: 'linear-gradient(135deg,#3B82F6,#2563EB)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 900, fontSize: 14, color: '#fff', flexShrink: 0 },
  brandName:   { fontSize: 16, fontWeight: 800, color: '#0F172A', letterSpacing: '-0.3px' },
  brandSub:    { fontSize: 11, color: '#94A3B8', letterSpacing: '0px', marginTop: 1, fontWeight: 500 },
  btnGhost:    { background: 'transparent', border: '1px solid #E5E7EB', color: '#6B7280', padding: '8px 16px', borderRadius: 8, fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', fontWeight: 600, transition: 'all 0.15s', outline: 'none' },

  statusBar:   { background: '#FFF', borderBottom: '1px solid #E5E7EB', padding: '12px 28px', display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' },
  statusChip:  { fontSize: 12, background: '#F9FAFB', border: '1px solid #E5E7EB', padding: '6px 12px', borderRadius: 6, fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 8, fontWeight: 500 },

  body:        { flex: 1, display: 'flex', overflow: 'hidden', minHeight: 0 },

  // Config panel
  configPanel: { width: 280, minWidth: 280, background: '#FFF', borderRight: '1px solid #E5E7EB', padding: '24px 20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 0 },
  configTitle: { fontSize: 10, fontWeight: 800, color: '#9CA3AF', letterSpacing: '1.2px', textTransform: 'uppercase', marginBottom: 20 },
  fieldGroup:  { marginBottom: 20 },
  fieldLabel:  { fontSize: 10, fontWeight: 700, color: '#9CA3AF', letterSpacing: '0.8px', textTransform: 'uppercase', marginBottom: 10 },
  togBtn:      { padding: '9px 0', background: '#F9FAFB', border: '1px solid #E5E7EB', color: '#6B7280', borderRadius: 7, cursor: 'pointer', fontSize: 12, fontWeight: 700, fontFamily: 'inherit', transition: 'all 0.2s', outline: 'none' },
  togActive:   { background: '#DBEAFE', borderColor: '#BFDBFE', color: '#1D4ED8', fontWeight: 800 },
  divBtn:      { width: 48, height: 48, background: '#F3F4F6', border: '2px solid #E5E7EB', color: '#6B7280', borderRadius: 8, cursor: 'pointer', fontSize: 16, fontWeight: 800, fontFamily: 'inherit', transition: 'all 0.2s', outline: 'none' },
  algoBtn:     { flex: 1, padding: '9px 0', background: '#F3F4F6', border: '1px solid #E5E7EB', color: '#6B7280', borderRadius: 7, cursor: 'pointer', fontSize: 11, fontWeight: 700, fontFamily: 'inherit', transition: 'all 0.2s', outline: 'none' },
  input:       { width: '100%', background: '#F9FAFB', border: '1px solid #E5E7EB', color: '#111827', padding: '9px 11px', borderRadius: 7, fontSize: 12, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box', transition: 'all 0.2s' },
  infoNote:    { background: '#F0F9FF', border: '1px solid #E0F2FE', borderRadius: 8, padding: '11px 12px', fontSize: 11, color: '#0369A1', lineHeight: 1.5, marginBottom: 20, display: 'flex', gap: 8, alignItems: 'flex-start' },
  summaryRow:  { display: 'flex', background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '12px 14px', marginBottom: 20 },
  summaryCell: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
  summaryK:    { fontSize: 9, color: '#9CA3AF', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 600 },
  summaryV:    { fontSize: 16, fontWeight: 800, color: '#111827' },
  btnGenerate: { width: '100%', background: 'linear-gradient(135deg,#3B82F6,#2563EB)', border: 'none', color: '#fff', padding: '13px', borderRadius: 8, fontSize: 13, fontWeight: 800, cursor: 'pointer', fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, transition: 'all 0.2s', boxShadow: '0 2px 8px rgba(59, 130, 246, 0.25)' },
  btnDisabled: { opacity: 0.5, cursor: 'not-allowed', boxShadow: 'none' },

  // Right panel
  rightPanel:  { flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minWidth: 0, background: '#F8FAFC' },

  emptyState:  { flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 16, padding: 40, textAlign: 'center' },
  emptyIcon:   { fontSize: 56 },
  emptyTitle:  { fontSize: 21, fontWeight: 800, color: '#0F172A', letterSpacing: '-0.3px' },
  emptySub:    { fontSize: 14, color: '#6B7280', maxWidth: 400, lineHeight: 1.6 },

  logCard:     { padding: 32, maxWidth: 600, margin: '48px auto', width: '100%' },
  logBox:      { background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 8, padding: '11px 13px', fontFamily: "'DM Mono', monospace", fontSize: 11, display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 240, overflowY: 'auto' },
  logLine:     { color: '#374151', lineHeight: 1.5, fontWeight: 500 },

  // Results
  resultTopbar: { display: 'flex', alignItems: 'center', padding: '12px 18px', borderBottom: '1px solid #E5E7EB', background: '#FFF', gap: 10, flexWrap: 'wrap', justifyContent: 'space-between' },
  divTab:       { background: '#F9FAFB', border: '1px solid #E5E7EB', borderRadius: 7, padding: '8px 12px', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, transition: 'all 0.2s', fontSize: 12, outline: 'none' },
  divTabActive: { background: '#DBEAFE', borderColor: '#BFDBFE' },
  metricChip:   { background: '#F0F9FF', border: '1px solid #E0F2FE', color: '#0369A1', padding: '5px 11px', borderRadius: 99, fontSize: 11, fontFamily: "'DM Mono', monospace", fontWeight: 600 },
  btnPublish:   { background: 'linear-gradient(135deg,#3B82F6,#2563EB)', border: 'none', color: '#fff', padding: '7px 14px', borderRadius: 7, fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', transition: 'all 0.2s', boxShadow: '0 2px 6px rgba(59, 130, 246, 0.2)', display: 'flex', alignItems: 'center', gap: 6, outline: 'none' },
  btnPublished: { background: 'linear-gradient(135deg,#10B981,#059669)', boxShadow: '0 2px 8px rgba(16, 185, 129, 0.2)' },
  conflictBanner: { padding: '10px 14px', background: '#FFFBEB', borderBottom: '1px solid #FCD34D', fontSize: 11, display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 },

  // Table
  table:   { width: '100%', borderCollapse: 'collapse', minWidth: 900 },
  thTime:  { width: 130, padding: '8px 12px', background: '#F9FAFB', color: '#94A3B8', fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '2px solid #E5E7EB', textAlign: 'left', position: 'sticky', top: 0, zIndex: 10 },
  th:      { padding: '8px 12px', background: '#F9FAFB', color: '#94A3B8', fontSize: 9, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', borderBottom: '2px solid #E5E7EB', textAlign: 'center', position: 'sticky', top: 0, zIndex: 10 },
  tdTime:  { padding: '6px 12px', background: '#FFF', borderRight: '1px solid #F1F5F9', borderBottom: '1px solid #F1F5F9', verticalAlign: 'top', minWidth: 130 },
  timeLabel: { fontSize: 11, color: '#374151', fontFamily: "'DM Mono', monospace", lineHeight: 1.4, fontWeight: 700, marginBottom: 3 },
  slotBadge: { fontSize: 8, fontWeight: 700, padding: '2px 8px', borderRadius: 99, display: 'inline-block', textTransform: 'uppercase', letterSpacing: '.3px' },
  td:      { padding: '6px 12px', borderBottom: '1px solid #F1F5F9', verticalAlign: 'top', minWidth: 156, background: '#FFF', transition: 'background-color 0.15s ease' },
  tdOver:  { background: '#F0F9FF', outline: '2px dashed #7DD3FC', outlineOffset: -2 },
  dropHint:{ height: 60, border: '2px dashed #BFDBFE', borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#64748B', fontSize: 11, fontWeight: 600, background: '#F0F9FF' },

  // Modal
  modalBg:    { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', backdropFilter: 'blur(8px)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modal:      { background: '#FFF', border: '1px solid #E5E7EB', borderRadius: 20, padding: 28, maxWidth: 480, width: '100%', boxShadow: '0 32px 80px rgba(0,0,0,.15)' },
  modalClose: { background: '#F3F4F6', border: '1px solid #E5E7EB', color: '#6B7280', width: 30, height: 30, borderRadius: 7, cursor: 'pointer', fontSize: 11, fontWeight: 700 },

  toast: { position: 'fixed', bottom: 24, right: 24, zIndex: 9999, padding: '12px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, border: '1px solid #16a34a', background: '#052e1a', color: '#86efac', boxShadow: '0 8px 24px rgba(0,0,0,.12)', animation: 'slideUp 0.3s ease', display: 'flex', alignItems: 'center', gap: 8 },
};

const CSS = `
  * { box-sizing: border-box; }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: #F9FAFB; }
  ::-webkit-scrollbar-thumb { background: #D1D5DB; border-radius: 3px; transition: background 0.2s; }
  ::-webkit-scrollbar-thumb:hover { background: #9CA3AF; }
  
  /* Cards & Interactive Elements */
  .tt-card { transition: all 0.2s ease; }
  .tt-card:hover { transform: translateY(-2px); box-shadow: 0 6px 16px rgba(0,0,0,.1); }
  .tt-card:focus-visible { outline: 2px solid #3B82F6; outline-offset: 2px; }
  .tt-card:active { transform: translateY(0); }
  
  /* Buttons */
  .generate-btn:not([disabled]):hover { transform: translateY(-2px); box-shadow: 0 8px 20px rgba(59, 130, 246, 0.4); }
  .generate-btn:not([disabled]):focus-visible { outline: 2px solid #3B82F6; outline-offset: 2px; }
  .generate-btn:active:not([disabled]) { transform: translateY(0); }
  button:focus-visible { outline: 2px solid #3B82F6; outline-offset: 2px; }
  
  /* Modal interactions */
  .modal-close-btn:hover { background: #E5E7EB !important; transform: scale(1.05); }
  .modal-close-btn:focus-visible { outline: 2px solid #3B82F6; outline-offset: 2px; }
  .modal-close-btn:active { transform: scale(0.95); }
  
  /* Table hover states */
  tbody tr:hover { background-color: #F9FAFB; }
  tbody tr:hover td { background-color: #F9FAFB; }
  
  /* Division tabs */
  [role="button"]:hover { opacity: 0.8; }
  [role="button"]:focus-visible { outline: 2px solid #3B82F6; outline-offset: -2px; border-radius: 6px; }
  
  /* Animations */
  .fade-in { animation: fadeIn 0.35s ease-out; }
  .modal-in { animation: modalIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1); }
  .spin-sm { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #E5E7EB; border-top-color: #3B82F6; animation: spin 0.8s linear infinite; flex-shrink: 0; }
  .spin-lg { width: 28px; height: 28px; border-radius: 50%; border: 3px solid #E5E7EB; border-top-color: #3B82F6; animation: spin 0.9s linear infinite; }
  
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes modalIn { from { opacity: 0; transform: scale(0.94); } to { opacity: 1; transform: scale(1); } }
  @keyframes modalSlideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes backdropIn { from { opacity: 0; } to { opacity: 1; } }
  @keyframes slideUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  
  /* Focus & Accessibility */
  input:focus { border-color: #3B82F6 !important; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1); outline: none; }
  input:focus-visible { outline: 2px solid #3B82F6; outline-offset: 2px; }
  button:focus { outline: none; }
  button:focus-visible { outline: 2px solid #3B82F6; outline-offset: 2px; }
  *:focus-visible { outline-width: 2px; outline-style: solid; outline-color: #3B82F6; }
  
  /* Details/Summary */
  details summary::-webkit-details-marker { display: none; }
  details summary { cursor: pointer; user-select: none; padding: 4px 0; }
  details summary:focus-visible { outline: 2px solid #3B82F6; outline-offset: 2px; }
  
  /* Reduced motion support */
  @media (prefers-reduced-motion: reduce) {
    * { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  }
`;

const tick = (ms: number) => new Promise(r => setTimeout(r, ms));

export default TimetableGenerationPage;