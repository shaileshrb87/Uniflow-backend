const express = require('express');
const router  = express.Router();
const { auth } = require('../middleware/auth');
const {
  createSwapRequest,
  getIncomingRequests,
  getOutgoingRequests,
  getAdminPendingRequests,
  getSwapById,
  respondToSwap,
  adminAction,
  cancelSwapRequest,
} = require('../controllers/Swapcontroller');

router.use(auth);

// ── Teacher endpoints ─────────────────────────────────────────────────────────

// Create a lecture swap request (cross-division supported)
// POST /api/swaps
router.post('/', createSwapRequest);

// Requests sent TO the logged-in teacher
// GET /api/swaps/incoming
// GET /api/swaps/incoming?status=all
router.get('/incoming', getIncomingRequests);

// Requests sent BY the logged-in teacher
// GET /api/swaps/outgoing
// GET /api/swaps/outgoing?status=approved
router.get('/outgoing', getOutgoingRequests);

// ── Admin ─────────────────────────────────────────────────────────────────────

// Admin queue — swaps awaiting admin decision
// GET /api/swaps/admin
// GET /api/swaps/admin?status=all
router.get('/admin', getAdminPendingRequests);

// ── Single swap ───────────────────────────────────────────────────────────────

// GET /api/swaps/:id
router.get('/:id', getSwapById);

// Target teacher accepts or rejects
// PATCH /api/swaps/:id/respond
// Body: { action: 'accept'|'reject', note? }
router.patch('/:id/respond', respondToSwap);

// Admin approves or rejects (after both teachers agreed)
// PATCH /api/swaps/:id/admin-action
// Body: { action: 'approve'|'reject', note? }
router.patch('/:id/admin-action', adminAction);

// Requester cancels
// PATCH /api/swaps/:id/cancel
router.patch('/:id/cancel', cancelSwapRequest);

module.exports = router;