import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useRouter } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  FlatList,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import Modal from '../../components/ui/Modal';
import Toast from '../../components/ui/Toast';
import { BorderRadius, Colors, FontSize, Spacing } from '../../constants/theme';
import { useFocusRefetch } from '../../hooks/useFocusRefetch';
import { groupsService } from '../../services/groups.service';
import { GroupLabel } from '../../types';

// ─── Types ────────────────────────────────────────────────────────────────────

type GroupType = 'flat' | 'hierarchical';

// Pull the DRF error `detail` string off an axios error, if present. Returns
// undefined for non-HTTP failures (network down) — the caller falls back to a
// generic message. Same helper shape as the churches/queue screens.
function extractDetail(err: unknown): string | undefined {
  const data = (err as { response?: { data?: unknown } })?.response?.data;
  if (data && typeof data === 'object' && 'detail' in data) {
    const d = (data as { detail?: unknown }).detail;
    if (typeof d === 'string') return d;
  }
  return undefined;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function TypeBadge({ isHierarchical }: { isHierarchical: boolean }) {
  return (
    <View style={[styles.typeBadge, isHierarchical && styles.typeBadgeH]}>
      <Text style={[styles.typeBadgeText, isHierarchical && styles.typeBadgeTextH]}>
        {isHierarchical ? 'Hierarchical' : 'Flat'}
      </Text>
    </View>
  );
}

// ─── Group Labels screen ──────────────────────────────────────────────────────

export default function GroupLabelsScreen() {
  const router = useRouter();

  // Active vs Archived view. The split is SERVER-SIDE (GET /group-labels/?archived=
  // <bool>), so toggling must REFETCH — see the effect below.
  const [showArchived, setShowArchived] = useState(false);

  // JWT read via the shared `api` instance (NOT the portal client). A 401 is handled
  // by api.ts's refresh-and-retry interceptor — no portal-chokepoint logic here.
  // Background refetch-on-focus, mirroring (super)/churches.tsx.
  const { data, status: fetchState, retry } = useFocusRefetch<GroupLabel[]>(
    () => groupsService.list(showArchived),
  );
  const labels = data ?? [];

  // useFocusRefetch only fetches on FOCUS, not when showArchived flips. retry() re-runs
  // with the latest showArchived (fetcherRef updates each render). Skip the initial
  // mount — useFocusEffect already does the first fetch (avoids a double fetch).
  const firstToggle = useRef(true);
  useEffect(() => {
    if (firstToggle.current) {
      firstToggle.current = false;
      return;
    }
    retry();
  }, [showArchived, retry]);

  // Hardware-back → Settings (hidden-tab pattern).
  useFocusEffect(
    useCallback(() => {
      const sub = BackHandler.addEventListener('hardwareBackPress', () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        router.navigate('/(treasurer)/settings' as any);
        return true;
      });
      return () => sub.remove();
    }, [router])
  );

  // Add form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<GroupType>('flat');
  const [newParentId, setNewParentId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  // Inline rename
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  // Per-row mutation in flight (archive / unarchive / rename-save). One at a time.
  const [busyId, setBusyId] = useState<string | null>(null);

  // Archive confirm modal (web-safe — replaces the old Alert.alert, a no-op on web).
  const [confirmTarget, setConfirmTarget] = useState<GroupLabel | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Transient toast (success + non-modal errors). Works on Expo web.
  const [toast, setToast] = useState<{ msg: string; type: 'success' | 'error' } | null>(null);
  function showToast(msg: string, type: 'success' | 'error' = 'success') {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }

  // ── Add group ──────────────────────────────────────────────────────────────

  function toggleAddForm() {
    setShowAddForm(v => !v);
    if (showAddForm) {
      setNewName('');
      setNewType('flat');
      setNewParentId(null);
    }
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name || creating) return;
    if (newType === 'hierarchical' && !newParentId) {
      showToast('Pick a parent label for a hierarchical group.', 'error');
      return;
    }
    setCreating(true);
    try {
      // Key conversion lives in the service: parentLabelId → parent_label. A flat
      // group sends parent_label: null; a hierarchical one sends the chosen parent id.
      await groupsService.create({
        name,
        parentLabelId: newType === 'hierarchical' ? newParentId! : undefined,
      });
      setNewName('');
      setNewType('flat');
      setNewParentId(null);
      setShowAddForm(false);
      showToast('Group created.');
      retry();   // server truth
    } catch (err) {
      showToast(extractDetail(err) ?? "Couldn't create group. Try again.", 'error');
    } finally {
      setCreating(false);
    }
  }

  // ── Rename ────────────────────────────────────────────────────────────────

  function startRename(group: GroupLabel) {
    setEditingId(group.id);
    setEditingName(group.name);
  }

  function cancelRename() {
    setEditingId(null);
    setEditingName('');
  }

  async function commitRename(id: string) {
    const name = editingName.trim();
    const current = labels.find(l => l.id === id);
    if (!name || (current && name === current.name)) {
      cancelRename();   // empty or unchanged → no-op
      return;
    }
    if (busyId) return;
    setBusyId(id);
    try {
      await groupsService.rename(id, name);
      setEditingId(null);
      setEditingName('');
      showToast('Group renamed.');
      retry();
    } catch (err) {
      // Keep the edit row open so the typed name isn't lost; surface the reason.
      showToast(extractDetail(err) ?? "Couldn't rename. Try again.", 'error');
    } finally {
      setBusyId(null);
    }
  }

  // ── Archive (active view) ───────────────────────────────────────────────────

  function handleArchivePress(group: GroupLabel) {
    if (busyId) return;
    // Client-side pre-check (UX) — don't even open the confirm if the count is > 0.
    // The backend enforces the SAME rule; the race (count changes between refetch and
    // click) is caught in confirmArchive() and surfaced from the 400.
    if (group.activeCampaignCount > 0) {
      showToast(
        `"${group.name}" has ${group.activeCampaignCount} active campaign${group.activeCampaignCount !== 1 ? 's' : ''}. Close or reassign them first.`,
        'error',
      );
      return;
    }
    setConfirmError(null);
    setConfirmTarget(group);
  }

  async function confirmArchive() {
    const group = confirmTarget;
    if (!group || busyId) return;
    setBusyId(group.id);
    setConfirmError(null);
    try {
      await groupsService.archive(group.id);
      setConfirmTarget(null);
      showToast(`"${group.name}" archived.`);
      retry();
    } catch (err) {
      // Backend archive-guard 400 (or a race) — SURFACE the detail INSIDE the modal
      // (the modal stays open, so a toast would render behind it). Then re-sync counts.
      setConfirmError(extractDetail(err) ?? "Couldn't archive. Try again.");
      retry();
    } finally {
      setBusyId(null);
    }
  }

  function closeConfirm() {
    if (busyId) return;
    setConfirmTarget(null);
    setConfirmError(null);
  }

  // ── Unarchive (archived view) ───────────────────────────────────────────────

  async function handleUnarchive(group: GroupLabel) {
    if (busyId) return;
    setBusyId(group.id);
    try {
      await groupsService.unarchive(group.id);
      showToast(`"${group.name}" restored.`);
      retry();
    } catch (err) {
      showToast(extractDetail(err) ?? "Couldn't restore. Try again.", 'error');
    } finally {
      setBusyId(null);
    }
  }

  // ── Row renderer ──────────────────────────────────────────────────────────

  function renderItem({ item }: { item: GroupLabel }) {
    const isEditing = editingId === item.id;
    const isHierarchical = !!item.parentLabelId;
    const canArchive = item.activeCampaignCount === 0;
    const rowBusy = busyId === item.id;

    return (
      <View style={styles.row}>
        {/* Left: badge + name/edit + count */}
        <View style={styles.rowLeft}>
          <TypeBadge isHierarchical={isHierarchical} />

          {isEditing ? (
            <View style={styles.renameRow}>
              <TextInput
                style={styles.renameInput}
                value={editingName}
                onChangeText={setEditingName}
                autoFocus
                editable={!rowBusy}
                returnKeyType="done"
                onSubmitEditing={() => commitRename(item.id)}
                accessibilityLabel="Edit group name"
              />
              <TouchableOpacity
                style={[styles.renameSaveBtn, rowBusy && styles.btnDisabled]}
                onPress={() => commitRename(item.id)}
                disabled={rowBusy}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Save name"
              >
                {rowBusy ? (
                  <ActivityIndicator size="small" color={Colors.white} />
                ) : (
                  <Text style={styles.renameSaveBtnText}>Save</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                onPress={cancelRename}
                disabled={rowBusy}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityRole="button"
                accessibilityLabel="Cancel rename"
              >
                <Ionicons name="close" size={18} color={Colors.textMuted} />
              </TouchableOpacity>
            </View>
          ) : showArchived ? (
            // Archived view: name is read-only (rename lives in the active view).
            <Text style={styles.groupName}>{item.name}</Text>
          ) : (
            <TouchableOpacity
              onPress={() => startRename(item)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Rename ${item.name}`}
            >
              <Text style={styles.groupName}>{item.name}</Text>
            </TouchableOpacity>
          )}

          <Text style={styles.campaignCount}>
            {item.activeCampaignCount === 0
              ? 'No active campaigns'
              : `${item.activeCampaignCount} active campaign${item.activeCampaignCount !== 1 ? 's' : ''}`}
          </Text>
        </View>

        {/* Right action: Archive (active view) or Unarchive (archived view) */}
        {showArchived ? (
          <TouchableOpacity
            style={[styles.unarchiveBtn, rowBusy && styles.btnDisabled]}
            onPress={() => handleUnarchive(item)}
            disabled={rowBusy}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={`Restore ${item.name}`}
          >
            {rowBusy ? (
              <ActivityIndicator size="small" color={Colors.primary} />
            ) : (
              <Ionicons name="arrow-undo-outline" size={18} color={Colors.primary} />
            )}
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            style={[styles.archiveBtn, !canArchive && styles.archiveBtnDisabled, rowBusy && styles.btnDisabled]}
            onPress={() => handleArchivePress(item)}
            disabled={rowBusy}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={
              canArchive ? `Archive ${item.name}` : `Cannot archive: has active campaigns`
            }
          >
            {rowBusy ? (
              <ActivityIndicator size="small" color={Colors.danger} />
            ) : (
              <Ionicons
                name="archive-outline"
                size={18}
                color={canArchive ? Colors.danger : Colors.border}
              />
            )}
          </TouchableOpacity>
        )}
      </View>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <View style={styles.root}>
      {toast ? (
        <View style={styles.toastWrap}>
          <Toast type={toast.type} message={toast.msg} visible />
        </View>
      ) : null}

      {/* ── Page header ── */}
      <View style={styles.pageHeader}>
        <TouchableOpacity
          style={styles.backIconBtn}
          onPress={() => router.navigate('/(treasurer)/settings' as any)}
          activeOpacity={0.7}
          accessibilityRole="button"
          accessibilityLabel="Go back to Settings"
        >
          <Ionicons name="arrow-back" size={22} color={Colors.primary} />
        </TouchableOpacity>
        <View style={styles.pageTitleBlock}>
          <Text style={styles.pageTitle}>Group Labels</Text>
          <Text style={styles.pageSubtitle}>Organise campaigns by group</Text>
        </View>
        {/* Add lives in the Active view only — new groups are created active. */}
        {!showArchived ? (
          <TouchableOpacity
            style={[styles.addBtn, showAddForm && styles.addBtnCancel]}
            onPress={toggleAddForm}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel={showAddForm ? 'Cancel' : 'Add group label'}
          >
            <Ionicons name={showAddForm ? 'close' : 'add'} size={18} color={Colors.white} />
            <Text style={styles.addBtnText}>{showAddForm ? 'Cancel' : 'Add Group'}</Text>
          </TouchableOpacity>
        ) : null}
      </View>

      {/* ── Active / Archived view toggle ── */}
      <View style={styles.viewToggleBar}>
        <TouchableOpacity
          style={[styles.viewChip, !showArchived && styles.viewChipActive]}
          onPress={() => setShowArchived(false)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Show active groups"
        >
          <Text style={[styles.viewChipText, !showArchived && styles.viewChipTextActive]}>Active</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.viewChip, showArchived && styles.viewChipActive]}
          onPress={() => setShowArchived(true)}
          activeOpacity={0.8}
          accessibilityRole="button"
          accessibilityLabel="Show archived groups"
        >
          <Text style={[styles.viewChipText, showArchived && styles.viewChipTextActive]}>Archived</Text>
        </TouchableOpacity>
      </View>

      {/* ── Inline add form (active view only) ── */}
      {showAddForm && !showArchived ? (
        <View style={styles.addForm}>
          <TextInput
            style={styles.addInput}
            placeholder="Group name"
            placeholderTextColor={Colors.textMuted}
            value={newName}
            onChangeText={setNewName}
            returnKeyType="done"
            autoFocus
            editable={!creating}
            accessibilityLabel="New group name"
          />

          <View style={styles.toggleRow}>
            <Text style={styles.toggleLabel}>Type</Text>
            <View style={styles.toggleGroup}>
              <TouchableOpacity
                style={[styles.toggleBtn, newType === 'flat' && styles.toggleBtnActive]}
                onPress={() => { setNewType('flat'); setNewParentId(null); }}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Flat type"
              >
                <Text style={[styles.toggleBtnText, newType === 'flat' && styles.toggleBtnTextActive]}>
                  Flat
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.toggleBtn, newType === 'hierarchical' && styles.toggleBtnActive]}
                onPress={() => setNewType('hierarchical')}
                activeOpacity={0.8}
                accessibilityRole="button"
                accessibilityLabel="Hierarchical type"
              >
                <Text style={[styles.toggleBtnText, newType === 'hierarchical' && styles.toggleBtnTextActive]}>
                  Hierarchical
                </Text>
              </TouchableOpacity>
            </View>
          </View>

          {/* Parent picker — a hierarchical group needs a real parent label (no more
              invented 'root'). Choose from the church's existing labels. */}
          {newType === 'hierarchical' ? (
            labels.length === 0 ? (
              <Text style={styles.parentHint}>Create a flat group first to use as a parent.</Text>
            ) : (
              <View style={styles.parentBlock}>
                <Text style={styles.parentLabel}>Parent</Text>
                <View style={styles.parentChipsRow}>
                  {labels.map(l => (
                    <TouchableOpacity
                      key={l.id}
                      style={[styles.parentChip, newParentId === l.id && styles.parentChipActive]}
                      onPress={() => setNewParentId(l.id)}
                      activeOpacity={0.7}
                      accessibilityRole="button"
                      accessibilityLabel={`Parent ${l.name}`}
                    >
                      <Text style={[styles.parentChipText, newParentId === l.id && styles.parentChipTextActive]}>
                        {l.name}
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              </View>
            )
          ) : null}

          <TouchableOpacity
            style={[
              styles.saveFormBtn,
              (!newName.trim() || creating || (newType === 'hierarchical' && !newParentId)) && styles.saveFormBtnDisabled,
            ]}
            onPress={handleCreate}
            disabled={!newName.trim() || creating || (newType === 'hierarchical' && !newParentId)}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Save group"
          >
            {creating ? (
              <ActivityIndicator size="small" color={Colors.white} />
            ) : (
              <Text style={styles.saveFormBtnText}>Save Group</Text>
            )}
          </TouchableOpacity>
        </View>
      ) : null}

      {/* ── Body: loading / error / list ── */}
      {fetchState === 'loading' ? (
        <View style={styles.centerBlock}>
          <ActivityIndicator size="large" color={Colors.primary} />
        </View>
      ) : fetchState === 'error' ? (
        <View style={styles.errorBlock}>
          <Ionicons name="cloud-offline-outline" size={40} color={Colors.border} />
          <Text style={styles.errorText}>Couldn’t load group labels.</Text>
          <TouchableOpacity
            style={styles.retryBtn}
            onPress={retry}
            activeOpacity={0.8}
            accessibilityRole="button"
            accessibilityLabel="Try again"
          >
            <Text style={styles.retryBtnText}>Try again</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <FlatList
          data={labels}
          keyExtractor={item => item.id}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Ionicons name="layers-outline" size={48} color={Colors.border} />
              <Text style={styles.emptyTitle}>
                {showArchived ? 'No archived groups' : 'No group labels yet'}
              </Text>
              <Text style={styles.emptySubtitle}>
                {showArchived
                  ? 'Archived groups will appear here.'
                  : 'Add your first group to organise campaigns.'}
              </Text>
            </View>
          }
        />
      )}

      {/* ── Archive confirm (web-safe Modal — NOT Alert.alert) ── */}
      <Modal
        visible={confirmTarget !== null}
        title="Archive Group"
        confirmLabel={busyId ? 'Archiving…' : 'Archive'}
        confirmVariant="danger"
        confirmDisabled={busyId !== null}
        onConfirm={confirmArchive}
        onCancel={closeConfirm}
      >
        <Text style={styles.confirmText}>
          Archive “{confirmTarget?.name}”? It will no longer appear in campaign creation.
          You can restore it later from the Archived view.
        </Text>
        {confirmError ? (
          <View style={styles.confirmErrorBox}>
            <Ionicons name="alert-circle-outline" size={16} color={Colors.danger} />
            <Text style={styles.confirmErrorText}>{confirmError}</Text>
          </View>
        ) : null}
      </Modal>
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: Colors.grey,
  },

  toastWrap: { paddingHorizontal: Spacing.md, paddingTop: Spacing.sm },

  // Page header
  pageHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    paddingHorizontal: Spacing.md,
    paddingTop: Spacing.md,
    paddingBottom: Spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    gap: Spacing.sm,
  },
  backIconBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  pageTitleBlock: {
    flex: 1,
  },
  pageTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.xl,
    color: Colors.text,
  },
  pageSubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
    marginTop: 2,
  },
  addBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.md,
    paddingHorizontal: 14,
    height: 40,
    gap: 6,
  },
  addBtnCancel: {
    backgroundColor: Colors.textMuted,
  },
  addBtnText: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.sm,
    color: Colors.white,
  },

  // View toggle (Active / Archived)
  viewToggleBar: {
    flexDirection: 'row',
    gap: Spacing.sm,
    backgroundColor: Colors.white,
    paddingHorizontal: Spacing.md,
    paddingBottom: Spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
  },
  viewChip: {
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  viewChipActive: { backgroundColor: Colors.primary, borderColor: Colors.primary },
  viewChipText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  viewChipTextActive: { color: Colors.white },

  // Add form
  addForm: {
    backgroundColor: Colors.white,
    borderBottomWidth: 1,
    borderBottomColor: Colors.border,
    padding: Spacing.md,
    gap: Spacing.sm,
  },
  addInput: {
    height: Spacing.touch,
    borderWidth: 1.5,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.md,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.white,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.md,
  },
  toggleLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
    width: 36,
  },
  toggleGroup: {
    flexDirection: 'row',
    borderWidth: 1,
    borderColor: Colors.border,
    borderRadius: BorderRadius.md,
    overflow: 'hidden',
  },
  toggleBtn: {
    paddingHorizontal: 18,
    paddingVertical: 8,
    backgroundColor: Colors.white,
  },
  toggleBtnActive: {
    backgroundColor: Colors.primary,
  },
  toggleBtnText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  toggleBtnTextActive: {
    color: Colors.white,
  },

  // Parent picker (hierarchical)
  parentBlock: { gap: 6 },
  parentLabel: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.textSecondary,
  },
  parentChipsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  parentChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: BorderRadius.pill,
    borderWidth: 1,
    borderColor: Colors.border,
    backgroundColor: Colors.white,
  },
  parentChipActive: { backgroundColor: Colors.primaryLight, borderColor: Colors.primary },
  parentChipText: {
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.xs,
    color: Colors.textSecondary,
  },
  parentChipTextActive: { color: Colors.primary, fontFamily: 'Poppins-Bold' },
  parentHint: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.sm,
    color: Colors.textMuted,
  },

  saveFormBtn: {
    height: Spacing.touch,
    backgroundColor: Colors.accent,
    borderRadius: BorderRadius.md,
    alignItems: 'center',
    justifyContent: 'center',
  },
  saveFormBtnDisabled: {
    opacity: 0.45,
  },
  saveFormBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.md,
    color: Colors.white,
  },

  // Loading / error (mirrors the wired super reads)
  centerBlock: { paddingVertical: 48, alignItems: 'center', justifyContent: 'center' },
  errorBlock: { paddingVertical: 40, alignItems: 'center', gap: Spacing.sm },
  errorText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
  },
  retryBtn: {
    marginTop: 4,
    paddingHorizontal: Spacing.lg,
    height: Spacing.touch,
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  retryBtnText: { fontFamily: 'Poppins-SemiBold', fontSize: FontSize.md, color: Colors.white },

  // List
  listContent: {
    padding: Spacing.md,
    paddingBottom: Spacing.xl,
  },
  separator: {
    height: Spacing.sm,
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: Colors.white,
    borderRadius: BorderRadius.lg,
    borderWidth: 1,
    borderColor: Colors.border,
    padding: Spacing.md,
    gap: Spacing.sm,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.04,
    shadowRadius: 2,
    elevation: 1,
  },
  rowLeft: {
    flex: 1,
    gap: 4,
  },

  // Type badge
  typeBadge: {
    alignSelf: 'flex-start',
    backgroundColor: Colors.primaryLight,
    borderRadius: BorderRadius.pill,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginBottom: 2,
  },
  typeBadgeH: {
    backgroundColor: Colors.accentLight,
  },
  typeBadgeText: {
    fontFamily: 'Poppins-Medium',
    fontSize: 10,
    color: Colors.primary,
  },
  typeBadgeTextH: {
    color: Colors.accentDark,
  },

  // Group name
  groupName: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.md,
    color: Colors.text,
  },
  campaignCount: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.xs,
    color: Colors.textMuted,
  },

  // Rename inline
  renameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  renameInput: {
    flex: 1,
    height: 38,
    borderWidth: 1.5,
    borderColor: Colors.primary,
    borderRadius: BorderRadius.sm,
    paddingHorizontal: Spacing.sm,
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.text,
    backgroundColor: Colors.white,
  },
  renameSaveBtn: {
    height: 38,
    minWidth: 56,
    paddingHorizontal: 14,
    backgroundColor: Colors.primary,
    borderRadius: BorderRadius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  renameSaveBtnText: {
    fontFamily: 'Poppins-Bold',
    fontSize: FontSize.sm,
    color: Colors.white,
  },

  // Archive button
  archiveBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.dangerLight,
  },
  archiveBtnDisabled: {
    backgroundColor: Colors.grey,
  },

  // Unarchive button
  unarchiveBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: BorderRadius.md,
    backgroundColor: Colors.primaryLight,
  },

  btnDisabled: { opacity: 0.6 },

  // Confirm modal body
  confirmText: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textSecondary,
    lineHeight: 22,
  },
  confirmErrorBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    backgroundColor: Colors.dangerLight,
    borderRadius: BorderRadius.md,
    paddingHorizontal: Spacing.sm,
    paddingVertical: 8,
    marginTop: Spacing.sm,
  },
  confirmErrorText: {
    flex: 1,
    fontFamily: 'Poppins-Medium',
    fontSize: FontSize.sm,
    color: Colors.danger,
  },

  // Empty state
  emptyState: {
    alignItems: 'center',
    paddingTop: 60,
    gap: Spacing.sm,
  },
  emptyTitle: {
    fontFamily: 'Poppins-SemiBold',
    fontSize: FontSize.lg,
    color: Colors.text,
    marginTop: Spacing.sm,
  },
  emptySubtitle: {
    fontFamily: 'Poppins-Regular',
    fontSize: FontSize.md,
    color: Colors.textMuted,
    textAlign: 'center',
    paddingHorizontal: Spacing.xl,
  },
});
