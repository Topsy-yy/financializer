// Team Collaboration — multiple users per business, each with a role that grants
// a fixed set of permissions. This module is the single source of truth for the
// role → permission matrix and for pure member-list operations (invite, change
// role, remove). Persistence and cross-user linking live in the route layer; the
// logic here is pure and unit-testable.

const crypto = require("crypto");

// Roles, most privileged first.
const ROLES = ["founder", "finance_officer", "accountant", "auditor", "investor"];

const ROLE_LABELS = {
  founder: "Founder",
  finance_officer: "Finance Officer",
  accountant: "Accountant",
  auditor: "Auditor",
  investor: "Investor"
};

// The five collaboration capabilities.
const PERMISSIONS = ["view", "edit", "approve", "comment", "resolve"];

const PERMISSION_LABELS = {
  view: "View",
  edit: "Edit",
  approve: "Approve",
  comment: "Comment",
  resolve: "Resolve"
};

// The permission matrix. Founder also implicitly manages the team (see canManageTeam).
const ROLE_PERMISSIONS = {
  founder:         ["view", "edit", "approve", "comment", "resolve"],
  finance_officer: ["view", "edit", "approve", "comment", "resolve"],
  accountant:      ["view", "edit", "comment", "resolve"],
  auditor:         ["view", "comment", "resolve"],
  investor:        ["view"]
};

function isValidRole(role) {
  return ROLES.indexOf(String(role)) !== -1;
}
function normalizeRole(role) {
  return isValidRole(role) ? String(role) : "investor";
}
function roleLabel(role) {
  return ROLE_LABELS[role] || "Member";
}
function permissionsFor(role) {
  return (ROLE_PERMISSIONS[normalizeRole(role)] || ["view"]).slice();
}
function can(role, permission) {
  return permissionsFor(role).indexOf(permission) !== -1;
}
// Only Founders manage the team (invite, change roles, remove members).
function canManageTeam(role) {
  return normalizeRole(role) === "founder";
}

// The full matrix as data, for the client to render and gate UI against.
function permissionMatrix() {
  return {
    roles: ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r], permissions: permissionsFor(r), manages_team: canManageTeam(r) })),
    permissions: PERMISSIONS.map((p) => ({ key: p, label: PERMISSION_LABELS[p] }))
  };
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(email));
}

function newId() {
  return "m_" + crypto.randomBytes(6).toString("hex");
}
function newToken() {
  return crypto.randomBytes(20).toString("hex");
}

// The owner is always the first Founder and cannot be demoted or removed.
function defaultTeam(owner, now) {
  const ts = now || new Date().toISOString();
  return {
    members: [{
      id: "owner",
      email: normalizeEmail(owner && owner.email),
      name: (owner && owner.name) || "Owner",
      role: "founder",
      status: "active",
      isOwner: true,
      invitedAt: ts,
      acceptedAt: ts,
      invitedBy: "owner",
      userId: (owner && owner.userId) || null,
      token: null
    }]
  };
}

// Keep the owner member in sync with the profile and guarantee it exists.
function ensureTeam(team, owner, now) {
  if (!team || !Array.isArray(team.members) || !team.members.length) {
    return defaultTeam(owner, now);
  }
  let ownerMember = team.members.find((m) => m.isOwner) || team.members.find((m) => m.id === "owner");
  if (!ownerMember) {
    ownerMember = defaultTeam(owner, now).members[0];
    team.members.unshift(ownerMember);
  } else {
    ownerMember.role = "founder";
    ownerMember.status = "active";
    ownerMember.isOwner = true;
    if (owner && owner.email) ownerMember.email = normalizeEmail(owner.email);
    if (owner && owner.name) ownerMember.name = owner.name;
    if (owner && owner.userId) ownerMember.userId = owner.userId;
  }
  return team;
}

function findMember(team, id) {
  return (team.members || []).find((m) => m.id === id) || null;
}
function findMemberByEmail(team, email) {
  const e = normalizeEmail(email);
  if (!e) return null;
  return (team.members || []).find((m) => normalizeEmail(m.email) === e) || null;
}
function countActiveFounders(team) {
  return (team.members || []).filter((m) => m.role === "founder" && m.status === "active").length;
}

// Invite a teammate by email. Returns { member, token }. Throws on bad input or
// a duplicate email already on the team.
function inviteMember(team, input, now) {
  const email = normalizeEmail(input && input.email);
  const role = normalizeRole(input && input.role);
  if (!isValidEmail(email)) throw new Error("invalid_email");
  if (role === "founder") throw new Error("cannot_invite_founder"); // ownership isn't transferable via invite
  if (findMemberByEmail(team, email)) throw new Error("already_on_team");
  const token = (input && input.token) || newToken();
  const member = {
    id: (input && input.id) || newId(),
    email,
    name: (input && input.name) || email.split("@")[0],
    role,
    status: "pending",
    isOwner: false,
    invitedAt: now || new Date().toISOString(),
    acceptedAt: null,
    invitedBy: (input && input.invitedBy) || "owner",
    userId: null,
    token
  };
  team.members.push(member);
  return { member, token };
}

function updateMemberRole(team, id, role) {
  const member = findMember(team, id);
  if (!member) throw new Error("member_not_found");
  if (member.isOwner) throw new Error("cannot_change_owner");
  const next = normalizeRole(role);
  if (next === "founder") throw new Error("cannot_assign_founder");
  member.role = next;
  return member;
}

function removeMember(team, id) {
  const member = findMember(team, id);
  if (!member) throw new Error("member_not_found");
  if (member.isOwner) throw new Error("cannot_remove_owner");
  team.members = team.members.filter((m) => m.id !== id);
  return member;
}

// Mark a pending invite accepted and bind it to the accepting user's identity.
function acceptInvite(team, token, user, now) {
  const member = (team.members || []).find((m) => m.token === token && m.status === "pending");
  if (!member) throw new Error("invalid_or_used_invite");
  member.status = "active";
  member.acceptedAt = now || new Date().toISOString();
  member.userId = (user && user.userId) || member.userId;
  if (user && user.name) member.name = user.name;
  if (user && user.email) member.email = normalizeEmail(user.email);
  member.token = null; // single-use
  return member;
}

module.exports = {
  ROLES,
  ROLE_LABELS,
  PERMISSIONS,
  PERMISSION_LABELS,
  ROLE_PERMISSIONS,
  isValidRole,
  normalizeRole,
  roleLabel,
  permissionsFor,
  can,
  canManageTeam,
  permissionMatrix,
  normalizeEmail,
  isValidEmail,
  newId,
  newToken,
  defaultTeam,
  ensureTeam,
  findMember,
  findMemberByEmail,
  countActiveFounders,
  inviteMember,
  updateMemberRole,
  removeMember,
  acceptInvite
};
