"use client";

import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { Card, Badge, Button, Toggle, Modal, ConfirmModal } from "@/shared/components";

const PROVIDER_OPTIONS = [
  { value: "all", label: "All Providers" },
  { value: "codebuddy-cn-api", label: "CodeBuddy CN API" },
  { value: "qoder-api", label: "Qoder API" },
];

const TYPE_OPTIONS = [
  { value: "regex", label: "Regex" },
  { value: "exact", label: "Exact" },
];

const EMPTY_FORM = {
  id: "",
  type: "regex",
  pattern: "",
  replacement: "",
  enabled: true,
  priority: 0,
  provider: "all",
};

export default function SanitizerPage() {
  const [rules, setRules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [editingRule, setEditingRule] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [formData, setFormData] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchRules = useCallback(async () => {
    try {
      const res = await fetch("/api/sanitizer");
      const data = await res.json();
      if (res.ok) setRules(data.rules || []);
    } catch (err) {
      console.error("Failed to fetch sanitizer rules:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRules();
  }, [fetchRules]);

  const handleToggle = async (rule) => {
    const newEnabled = rule.enabled ? 0 : 1;
    setRules((prev) =>
      prev.map((r) => (r.id === rule.id ? { ...r, enabled: newEnabled } : r))
    );
    try {
      await fetch("/api/sanitizer", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: rule.id, enabled: newEnabled }),
      });
    } catch {
      // Revert on failure
      setRules((prev) =>
        prev.map((r) => (r.id === rule.id ? { ...r, enabled: rule.enabled } : r))
      );
    }
  };

  const openAddModal = () => {
    setFormData(EMPTY_FORM);
    setFormError(null);
    setShowAddModal(true);
  };

  const openEditModal = (rule) => {
    setFormData({
      id: rule.id,
      type: rule.type,
      pattern: rule.pattern,
      replacement: rule.replacement || "",
      enabled: !!rule.enabled,
      priority: rule.priority ?? 0,
      provider: rule.provider || "all",
    });
    setFormError(null);
    setEditingRule(rule);
  };

  const closeModals = () => {
    setShowAddModal(false);
    setEditingRule(null);
    setFormError(null);
    setFormData(EMPTY_FORM);
  };

  const handleSubmit = async () => {
    if (!formData.id.trim()) {
      setFormError("ID is required");
      return;
    }
    if (!formData.pattern.trim()) {
      setFormError("Pattern is required");
      return;
    }
    if (formData.type === "regex") {
      try {
        new RegExp(formData.pattern);
      } catch (e) {
        setFormError(`Invalid regex: ${e.message}`);
        return;
      }
    }

    setSubmitting(true);
    setFormError(null);

    try {
      const isEdit = !!editingRule;
      const method = isEdit ? "PUT" : "POST";
      const body = isEdit
        ? {
            id: formData.id,
            type: formData.type,
            pattern: formData.pattern,
            replacement: formData.replacement,
            enabled: formData.enabled ? 1 : 0,
            priority: Number(formData.priority) || 0,
            provider: formData.provider,
          }
        : {
            id: formData.id.trim(),
            type: formData.type,
            pattern: formData.pattern,
            replacement: formData.replacement,
            enabled: formData.enabled ? 1 : 0,
            priority: Number(formData.priority) || 0,
            provider: formData.provider,
          };

      const res = await fetch("/api/sanitizer", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setFormError(data.error || `Request failed (${res.status})`);
        return;
      }

      closeModals();
      fetchRules();
    } catch (err) {
      setFormError(err.message || "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const res = await fetch(`/api/sanitizer?id=${encodeURIComponent(deleteTarget.id)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setRules((prev) => prev.filter((r) => r.id !== deleteTarget.id));
      }
    } catch {
      // Silently fail — rule stays in UI
    } finally {
      setDeleteTarget(null);
    }
  };

  const handleResetDefaults = async () => {
    setShowResetConfirm(false);
    try {
      // Delete all existing rules first
      await Promise.all(
        rules.map((r) =>
          fetch(`/api/sanitizer?id=${encodeURIComponent(r.id)}`, { method: "DELETE" })
        )
      );
      // Re-fetch to trigger re-seed (server seeds on empty table)
      await fetch("/api/sanitizer");
      fetchRules();
    } catch {
      fetchRules();
    }
  };

  const handleReload = () => {
    setLoading(true);
    fetchRules();
  };

  if (loading) {
    return (
      <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
        <div className="animate-pulse space-y-4">
          <div className="h-8 w-48 rounded bg-white/5" />
          <div className="h-64 rounded-xl bg-white/5" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6 px-1 sm:px-0">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg sm:text-xl font-semibold flex items-center gap-2 leading-tight">
            <span className="material-symbols-outlined text-[22px] text-primary">filter_alt</span>
            Sanitizer Rules
          </h2>
          <p className="text-sm text-text-muted mt-1">
            Manage message sanitization rules applied before provider dispatch.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="secondary" icon="refresh" onClick={handleReload}>
            Reload
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon="restart_alt"
            onClick={() => setShowResetConfirm(true)}
          >
            Reset to Defaults
          </Button>
          <Button size="sm" icon="add" onClick={openAddModal}>
            Add Rule
          </Button>
        </div>
      </div>

      {/* Rules Table */}
      <Card padding="none" className="overflow-hidden">
        {rules.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <span className="material-symbols-outlined text-[40px] text-text-muted mb-3">
              filter_alt_off
            </span>
            <p className="text-text-muted text-sm">No sanitizer rules configured.</p>
            <p className="text-text-muted/60 text-xs mt-1">
              Click &quot;Reset to Defaults&quot; to seed default rules or &quot;Add Rule&quot; to create one.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border-subtle bg-white/[0.02]">
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                    ID
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Type
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Pattern
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Replacement
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Enabled
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Provider
                  </th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Priority
                  </th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-text-muted uppercase tracking-wider">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {rules.map((rule) => (
                  <RuleRow
                    key={rule.id}
                    rule={rule}
                    onToggle={handleToggle}
                    onEdit={openEditModal}
                    onDelete={setDeleteTarget}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Rule count */}
      {rules.length > 0 && (
        <p className="text-xs text-text-muted">
          {rules.length} rule{rules.length !== 1 ? "s" : ""} &middot;{" "}
          {rules.filter((r) => r.enabled).length} enabled
        </p>
      )}

      {/* Add/Edit Modal */}
      <Modal
        isOpen={showAddModal || !!editingRule}
        onClose={closeModals}
        title={editingRule ? "Edit Sanitizer Rule" : "Add Sanitizer Rule"}
        size="lg"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={closeModals}>
              Cancel
            </Button>
            <Button
              size="sm"
              onClick={handleSubmit}
              disabled={submitting}
            >
              {submitting ? "Saving..." : editingRule ? "Update" : "Create"}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          {formError && (
            <div className="flex items-center gap-2 rounded-lg bg-red-500/10 border border-red-500/20 px-3 py-2 text-sm text-red-400">
              <span className="material-symbols-outlined text-[16px]">error</span>
              {formError}
            </div>
          )}

          {/* ID */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">
              Rule ID
            </label>
            <input
              type="text"
              value={formData.id}
              onChange={(e) => setFormData((f) => ({ ...f, id: e.target.value }))}
              disabled={!!editingRule}
              className="w-full rounded-lg bg-white/5 border border-border-subtle px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:outline-none focus:border-primary/50 disabled:opacity-50"
              placeholder="e.g. remove_claude_identity"
            />
          </div>

          {/* Type + Priority row */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">
                Type
              </label>
              <select
                value={formData.type}
                onChange={(e) => setFormData((f) => ({ ...f, type: e.target.value }))}
                className="w-full rounded-lg bg-white/5 border border-border-subtle px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary/50"
              >
                {TYPE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-text-muted mb-1">
                Priority
              </label>
              <input
                type="number"
                value={formData.priority}
                onChange={(e) => setFormData((f) => ({ ...f, priority: e.target.value }))}
                className="w-full rounded-lg bg-white/5 border border-border-subtle px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:outline-none focus:border-primary/50"
                placeholder="0"
              />
            </div>
          </div>

          {/* Pattern */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">
              Pattern
            </label>
            <input
              type="text"
              value={formData.pattern}
              onChange={(e) => setFormData((f) => ({ ...f, pattern: e.target.value }))}
              className="w-full rounded-lg bg-white/5 border border-border-subtle px-3 py-2 text-sm font-mono text-text-main placeholder:text-text-muted/50 focus:outline-none focus:border-primary/50"
              placeholder={formData.type === "regex" ? "e.g. You are Claude Code[^.]*\\." : "e.g. Claude Code"}
            />
          </div>

          {/* Replacement */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">
              Replacement
            </label>
            <input
              type="text"
              value={formData.replacement}
              onChange={(e) => setFormData((f) => ({ ...f, replacement: e.target.value }))}
              className="w-full rounded-lg bg-white/5 border border-border-subtle px-3 py-2 text-sm text-text-main placeholder:text-text-muted/50 focus:outline-none focus:border-primary/50"
              placeholder="(empty string to remove)"
            />
          </div>

          {/* Provider */}
          <div>
            <label className="block text-xs font-medium text-text-muted mb-1">
              Provider
            </label>
            <select
              value={formData.provider}
              onChange={(e) => setFormData((f) => ({ ...f, provider: e.target.value }))}
              className="w-full rounded-lg bg-white/5 border border-border-subtle px-3 py-2 text-sm text-text-main focus:outline-none focus:border-primary/50"
            >
              {PROVIDER_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          {/* Enabled toggle */}
          <div className="flex items-center gap-3">
            <Toggle
              checked={formData.enabled}
              onChange={(val) => setFormData((f) => ({ ...f, enabled: val }))}
              size="sm"
            />
            <span className="text-sm text-text-muted">
              {formData.enabled ? "Enabled" : "Disabled"}
            </span>
          </div>
        </div>
      </Modal>

      {/* Delete Confirmation */}
      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Sanitizer Rule"
        message={`Are you sure you want to delete rule "${deleteTarget?.id}"? This action cannot be undone.`}
        confirmText="Delete"
        cancelText="Cancel"
        variant="danger"
      />

      {/* Reset Confirmation */}
      <ConfirmModal
        isOpen={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={handleResetDefaults}
        title="Reset to Defaults"
        message="This will delete all current rules and re-seed the default sanitizer rules. Any custom rules will be lost."
        confirmText="Reset"
        cancelText="Cancel"
        variant="danger"
      />
    </div>
  );
}

function RuleRow({ rule, onToggle, onEdit, onDelete }) {
  const providerLabel =
    PROVIDER_OPTIONS.find((p) => p.value === rule.provider)?.label || rule.provider || "All Providers";

  return (
    <tr className="group hover:bg-white/[0.02] transition-colors">
      {/* ID */}
      <td className="px-4 py-3">
        <button
          onClick={() => onEdit(rule)}
          className="text-left text-sm font-medium text-text-main hover:text-primary transition-colors cursor-pointer"
          title="Click to edit"
        >
          {rule.id}
        </button>
      </td>

      {/* Type */}
      <td className="px-4 py-3">
        <Badge
          variant={rule.type === "regex" ? "info" : "default"}
          size="sm"
        >
          {rule.type}
        </Badge>
      </td>

      {/* Pattern */}
      <td className="px-4 py-3 max-w-[280px]">
        <code className="block truncate text-xs font-mono text-amber-400/80 bg-white/5 rounded px-2 py-1" title={rule.pattern}>
          {rule.pattern}
        </code>
      </td>

      {/* Replacement */}
      <td className="px-4 py-3 max-w-[160px]">
        {rule.replacement ? (
          <span className="block truncate text-xs text-text-muted" title={rule.replacement}>
            {rule.replacement}
          </span>
        ) : (
          <span className="text-xs text-text-muted/40 italic">(remove)</span>
        )}
      </td>

      {/* Enabled */}
      <td className="px-4 py-3 text-center">
        <div className="flex justify-center">
          <Toggle
            checked={!!rule.enabled}
            onChange={() => onToggle(rule)}
            size="sm"
          />
        </div>
      </td>

      {/* Provider */}
      <td className="px-4 py-3">
        <span className="text-xs text-text-muted">{providerLabel}</span>
      </td>

      {/* Priority */}
      <td className="px-4 py-3 text-center">
        <span className="text-xs font-mono text-text-muted tabular-nums">{rule.priority ?? 0}</span>
      </td>

      {/* Actions */}
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
          <button
            onClick={() => onEdit(rule)}
            className="p-1.5 rounded-lg hover:bg-white/10 text-text-muted hover:text-primary transition-colors cursor-pointer"
            title="Edit rule"
            aria-label="Edit rule"
          >
            <span className="material-symbols-outlined text-[16px]">edit</span>
          </button>
          <button
            onClick={() => onDelete(rule)}
            className="p-1.5 rounded-lg hover:bg-white/10 text-text-muted hover:text-red-400 transition-colors cursor-pointer"
            title="Delete rule"
            aria-label="Delete rule"
          >
            <span className="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
      </td>
    </tr>
  );
}

RuleRow.propTypes = {
  rule: PropTypes.shape({
    id: PropTypes.string.isRequired,
    type: PropTypes.string.isRequired,
    pattern: PropTypes.string.isRequired,
    replacement: PropTypes.string,
    enabled: PropTypes.oneOfType([PropTypes.number, PropTypes.bool]),
    priority: PropTypes.number,
    provider: PropTypes.string,
  }).isRequired,
  onToggle: PropTypes.func.isRequired,
  onEdit: PropTypes.func.isRequired,
  onDelete: PropTypes.func.isRequired,
};
