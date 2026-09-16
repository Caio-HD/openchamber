import React from 'react';
import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Button } from '@/components/ui/button';
import { formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { requestDirectoryAccess } from '@/lib/desktop';
import { sessionEvents } from '@/lib/sessionEvents';
import { CHAT_DRAFT_PROJECT_ID } from '@/lib/chatDirectories';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { useChildStoreManager } from '@/sync/sync-context';
import type { ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { Icon } from '@/components/icon/Icon';
import { SessionFolderItem } from '../../SessionFolderItem';
import { DirectoryActionIndicator } from '../sessions/DirectoryActionIndicator';
import { SessionTreeItem } from '../sessions/SessionTreeItem';
import { computeNodeStructureKey, nodeContainsSessionId } from '../sessions/sessionNodeItemUtils';
import { DroppableFolderWrapper } from '../folders/sessionFolderDnd';
import { FolderDeleteConfirmDialog, type DeleteFolderConfirmState } from '../shell/ConfirmDialogs';
import type { SessionGroup } from '../types';
import { SessionSidebarRows } from '../SessionSidebarRows';
import { SessionSidebarActivityHeader } from '../sessionSidebarHeaderPresentation';
import { resolveSessionSidebarStickyHeader, type SessionSidebarRow, type SessionSidebarRowModel } from '../sessionSidebarRowModel';
import { ProjectHeaderIdentity, SortableGroupItem, SortableProjectItem } from './sortableItems';
import { SessionGroupSection, type SessionGroupSectionProps } from './SessionGroupSection';
import type { ProjectSection } from './sessionProjectRender';
import { formatProjectLabel } from '../utils';

type SessionProjectScrollerState = Pick<SessionGroupSectionProps,
  | 'editingId'
  | 'openSidebarMenuKey'
  | 'setOpenSidebarMenuKey'
> & {
  visibleSessionCountByGroup: Map<string, number>;
  collapsedActivityKeys: Set<string>;
  setCollapsedActivityKeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  visibleActivityCountByKey: Map<string, number>;
  setVisibleActivityCountByKey: React.Dispatch<React.SetStateAction<Map<string, number>>>;
};

type GroupProps = Pick<SessionGroupSectionProps,
  | 'hasSessionSearchQuery' | 'normalizedSessionSearchQuery' | 'groupSearchDataByGroup'
  | 'collapsedGroups' | 'hideDirectoryControls' | 'mobileVariant' | 'alwaysShowActions'
  | 'activeProjectId' | 'notifyOnSubtasks' | 'expandedParents' | 'editTitle'
  | 'editingRowKey'
  | 'copiedSessionId' | 'folderRename' | 'setFolderRenameDraft' | 'clearFolderRename'
  | 'setEditingId' | 'setEditingRowKey' | 'setEditTitle' | 'toggleParent' | 'allowReselect'
  | 'onSessionSelected' | 'resetSessionSearch' | 'deleteSessionConfirm'
  | 'setDeleteSessionConfirm' | 'startFolderRename' | 'setCopiedSessionId'
  | 'startSessionWorktreeMenuLoad'
> & { pinnedSessionIds: Set<string>; sessionOrderIndex: Map<string, number> };

type GroupActions = Pick<SessionGroupSectionProps,
  | 'showMoreGroupSessions' | 'resetGroupSessionLimit' | 'setActiveProjectIdOnly'
  | 'setSessionSwitcherOpen' | 'openNewSessionDraft' | 'onToggleCollapsedGroup'
>;

type SessionProjectScrollerModel = {
  rowModel: SessionSidebarRowModel;
  sectionsForRender: ProjectSection[];
  projectSections: ProjectSection[];
  activeProjectId: string | null;
  singleProjectMode: boolean;
  singleProjectId: string | null;
  emptyState: React.ReactNode;
  searchEmptyState: React.ReactNode;
  projectRepoStatus: Map<string, boolean | null>;
  state: SessionProjectScrollerState;
  groupProps: GroupProps;
};

type View = {
  homeDirectory: string | null;
  collapsedProjects: Set<string>;
  showOnlyMainWorkspace: boolean;
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  hideDirectoryControls: boolean;
  isDesktopShellRuntime: boolean;
  stickyZoneHeaders: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  projectSortOrder: ProjectSortOrder;
};

type Actions = {
  group: GroupActions;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null; targetFolderId?: string; target?: 'chat' | 'project' }) => void;
  openNewWorktreeDialog: () => void;
  openWorktreesPage: (id: string) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  reorderProjects: (fromIndex: number, toIndex: number) => void;
  setGroupOrderByProject: React.Dispatch<React.SetStateAction<Map<string, string[]>>>;
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  setSingleProjectId: (id: string) => void;
};

type Props = { model: SessionProjectScrollerModel; view: View; actions: Actions };
const TOP_FADE_MAX_SIZE = 48;
const TOP_FADE_MIN_SIZE = 32;
const TOP_FADE_CLEAR_MAX_SIZE = 24;

const getProjectLabel = (project: ProjectSection['project'], homeDirectory: string | null): string => formatProjectLabel(
  project.label?.trim() || formatDirectoryName(project.normalizedPath, homeDirectory) || project.normalizedPath,
);

function SessionProjectScrollerComponent({ model, view, actions }: Props): React.ReactNode {
  streamPerfCount('ui.sidebar_projects_list.render');
  const { t } = useI18n();
  const childStores = useChildStoreManager();
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const [folderDeleteConfirm, setFolderDeleteConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const [stickyIdentity, setStickyIdentity] = React.useState<string | null>(null);
  const [focusedRowKey, setFocusedRowKey] = React.useState<string | null>(null);
  const [scrollElement, setScrollElement] = React.useState<HTMLElement | null>(null);
  const topFadeSizeRef = React.useRef(0);
  const enableStickyFade = view.isDesktopShellRuntime && view.stickyZoneHeaders && !model.singleProjectMode;
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const syncTopFade = React.useCallback((scroller: HTMLElement) => {
    const size = scroller.scrollTop > 1 ? Math.min(TOP_FADE_MIN_SIZE + scroller.scrollTop, TOP_FADE_MAX_SIZE) : 0;
    topFadeSizeRef.current = size;
    const root = scroller.parentElement?.parentElement;
    root?.style.setProperty('--scroll-shadow-top-size', `${size}px`);
    root?.style.setProperty('--scroll-shadow-top-clear-size', `${Math.min(Math.max(size - 8, 0), TOP_FADE_CLEAR_MAX_SIZE)}px`);
  }, []);
  const blockObscuredInteraction = React.useCallback((event: React.MouseEvent<HTMLDivElement> | React.PointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('[data-overlay-scrollbar-thumb], [data-sidebar-sticky-header]')) return;
    if (event.clientY - event.currentTarget.getBoundingClientRect().top >= topFadeSizeRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const projectPickerOptions = React.useMemo(() => model.projectSections.map((section) => ({
    id: section.project.id,
    projectLabel: getProjectLabel(section.project, view.homeDirectory),
    projectDescription: formatPathForDisplay(section.project.normalizedPath, view.homeDirectory),
    projectIcon: section.project.icon,
    projectColor: section.project.color,
    projectIconImage: section.project.iconImage,
    projectIconBackground: section.project.iconBackground,
  })), [model.projectSections, view.homeDirectory]);

  const pinnedRowIndexes = React.useMemo(() => {
    const indexes = new Set<number>();
    if (focusedRowKey) {
      const focusedIndex = model.rowModel.rowIndexByKey.get(focusedRowKey);
      if (focusedIndex !== undefined) indexes.add(focusedIndex);
    }
    for (let index = 0; index < model.rowModel.rows.length; index += 1) {
      const row = model.rowModel.rows[index];
      if (row?.kind !== 'session') continue;
      if (model.groupProps.editingRowKey === row.key
        || model.state.openSidebarMenuKey === `session-menu:${row.key}`
        || model.state.openSidebarMenuKey === `session-context:${row.key}`) indexes.add(index);
    }
    return indexes;
  }, [focusedRowKey, model.groupProps.editingRowKey, model.rowModel.rowIndexByKey, model.rowModel.rows, model.state.openSidebarMenuKey]);

  const handleFirstVisibleIndexChange = React.useCallback((index: number) => {
    if (!enableStickyFade) return;
    const descriptor = resolveSessionSidebarStickyHeader(model.rowModel.stickyHeaders, index);
    const nextIdentity = descriptor ? `${descriptor.kind}:${descriptor.id}` : null;
    setStickyIdentity((current) => current === nextIdentity ? current : nextIdentity);
  }, [enableStickyFade, model.rowModel.stickyHeaders]);

  const renderStatus = React.useCallback((row: Extract<SessionSidebarRow, { kind: 'status' }>) => {
    const retry = () => {
      if (!row.status.directory) return;
      childStores.requestBootstrap({ directory: row.status.directory, priority: 'expanded', reason: row.group.isMain ? 'project-expanded' : 'worktree-expanded', force: true });
    };
    const grant = async () => {
      if (!row.status.directory) return;
      const result = await requestDirectoryAccess(row.status.directory);
      if (result.success) retry();
    };
    const label = row.status.state === 'permission-denied'
      ? t('sessions.sidebar.group.empty.permissionDenied')
      : row.status.state === 'load-failed'
        ? t('sessions.sidebar.group.empty.loadFailed')
        : row.status.state === 'initialization-failed'
          ? t('sessions.sidebar.group.empty.initializationFailed')
          : t('sessions.sidebar.group.empty.loadingSessions');
    return <div className="py-1 pl-[26px] text-left typography-micro text-muted-foreground">
      <span className="inline-flex flex-wrap items-center gap-1.5">
        {row.status.state === 'loading' ? <Icon name="loader-4" className="size-3 animate-spin" /> : null}
        {label}
        {row.status.canGrantAccess ? <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={() => void grant()}>{t('sessions.sidebar.group.empty.grantAccess')}</Button> : null}
        {row.status.state !== 'loading' ? <Button variant="link" size="xs" className="h-auto p-0 typography-micro" onClick={retry}>{t('sessions.sidebar.group.empty.retry')}</Button> : null}
      </span>
    </div>;
  }, [childStores, t]);

  const renderRow = React.useCallback((row: SessionSidebarRow): React.ReactNode => {
    if (row.kind === 'activity-header') {
      return <SessionSidebarActivityHeader
        activityKey={row.activityKey}
        collapsed={row.collapsed}
        forceExpanded={row.forceExpanded}
        alwaysShowActions={view.alwaysShowActions}
        onToggle={() => model.state.setCollapsedActivityKeys((current) => {
          const next = new Set(current);
          if (next.has(row.activityKey)) next.delete(row.activityKey); else next.add(row.activityKey);
          return next;
        })}
        onNewChat={() => {
          useUIStore.getState().closeMainSurfaces();
          if (view.mobileVariant) actions.setSessionSwitcherOpen(false);
          actions.openNewSessionDraft({ selectedProjectId: CHAT_DRAFT_PROJECT_ID, directoryOverride: null });
        }}
      />;
    }
    if (row.kind === 'project-header') {
      const project = row.section.project;
      const label = getProjectLabel(project, view.homeDirectory);
      return <SortableProjectItem
        id={project.id}
        disabled={row.forceExpanded || model.state.editingId !== null || view.projectSortOrder !== 'manual'}
        projectLabel={label}
        projectDescription={formatPathForDisplay(project.normalizedPath, view.homeDirectory)}
        projectDirectory={project.normalizedPath}
        projectIcon={project.icon} projectColor={project.color} projectIconImage={project.iconImage} projectIconBackground={project.iconBackground}
        isCollapsed={row.collapsed} isRepo={Boolean(model.projectRepoStatus.get(project.id))}
        isDesktopShell={view.isDesktopShellRuntime} hideDirectoryControls={view.hideDirectoryControls}
        mobileVariant={view.mobileVariant} alwaysShowActions={view.alwaysShowActions}
        statusIndicator={row.collapsed ? actions.renderProjectStatusIndicator?.(project.id, row.section.groups) : null}
        openSidebarMenuKey={model.state.openSidebarMenuKey} setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey}
        projectPickerOptions={model.singleProjectMode ? projectPickerOptions : undefined}
        onProjectSelect={model.singleProjectMode ? actions.setSingleProjectId : undefined}
        onToggle={() => { if (!row.forceExpanded && !model.singleProjectMode) actions.toggleProject(project.id); }}
        onNewSession={() => { actions.setActiveProjectIdOnly(project.id); actions.openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.normalizedPath }); }}
        onNewWorktreeSession={actions.openNewWorktreeDialog}
        onManageWorktrees={() => actions.openWorktreesPage(project.id)}
        onRenameStart={() => actions.openProjectEditDialog(project.id)}
        onClose={() => actions.removeProject(project.id)}
        sentinelRef={() => undefined}
        showCreateButtons
      />;
    }
    if (row.kind === 'group-header') {
      return <SortableGroupItem id={row.groupKey} disabled={row.forceExpanded || model.state.editingId !== null}>
        {(dragHandleProps) => <SessionGroupSection
          {...model.groupProps} {...actions.group}
          group={row.group} groupKey={row.groupKey} projectId={row.projectId}
          visibleSessionCount={model.state.visibleSessionCountByGroup.get(row.groupKey)}
          editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey}
          setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey}
          dragHandleProps={dragHandleProps} renderBody={false}
        />}
      </SortableGroupItem>;
    }
    if (row.kind === 'folder-header') {
      const renaming = model.groupProps.folderRename?.folderId === row.folder.id && model.groupProps.folderRename.scopeKey === row.scopeKey;
      return <DroppableFolderWrapper folderId={row.folder.id} scopeKey={row.scopeKey} ownerKey={row.ownerKey} disabled={!row.dropEnabled}>
        {(droppableRef, isDropTarget) => <SessionFolderItem
          folder={row.folder} displayName={row.displayName} sessions={row.nodes}
          isCollapsed={row.collapsed} onToggle={row.forceExpanded ? () => undefined : () => toggleFolderCollapse(row.folder.id)}
          onRename={(name) => renameFolder(row.scopeKey, row.folder.id, name)}
          onDelete={() => {
            if (row.archived) {
              sessionEvents.requestDelete({ sessions: [...row.deleteSessions], mode: 'session' });
            } else if (!showDeletionDialog) {
              deleteFolder(row.scopeKey, row.folder.id);
            } else {
              setFolderDeleteConfirm({ scopeKey: row.scopeKey, folderId: row.folder.id, folderName: row.folder.name, subFolderCount: row.subFolderCount, sessionCount: row.nodes.length });
            }
          }}
          renderBody={false} groupDirectory={row.scopeDirectory ?? row.group.directory} projectId={row.projectId}
          mobileVariant={view.mobileVariant} alwaysShowActions={view.alwaysShowActions}
          isRenaming={renaming} renameDraft={renaming ? model.groupProps.folderRename?.draft : undefined}
          onRenameDraftChange={model.groupProps.setFolderRenameDraft}
          onRenameSave={() => { const draft = model.groupProps.folderRename?.draft.trim(); if (draft) renameFolder(row.scopeKey, row.folder.id, draft); model.groupProps.clearFolderRename(); }}
          onRenameCancel={model.groupProps.clearFolderRename} droppableRef={droppableRef} isDropTarget={isDropTarget}
          onNewSession={() => actions.openNewSessionDraft({ selectedProjectId: row.projectId, directoryOverride: row.scopeDirectory ?? row.group.directory, targetFolderId: row.folder.id, target: row.group.draftTarget })}
          archivedBucket={row.archived}
        />}
      </DroppableFolderWrapper>;
    }
    if (row.kind === 'session') {
      const subtreeContainsEditing = new Set<string>();
      if (nodeContainsSessionId(row.node, model.state.editingId)) subtreeContainsEditing.add(row.node.session.id);
      return <div onFocusCapture={() => setFocusedRowKey(row.key)} onBlurCapture={() => setFocusedRowKey((current) => current === row.key ? null : current)}>
        <SessionTreeItem
          {...model.groupProps}
          node={row.node} depth={row.depth} groupDirectory={row.groupDirectory} projectId={row.projectId}
          folderOwnerKey={row.ownerKey} selectionScopeKey={row.selectionScopeKey}
          archivedBucket={row.archived} renderContext={row.renderContext} rowKey={row.key} dragKey={row.key}
          secondaryMeta={row.secondaryMeta} renderChildren={false}
          editingId={model.state.editingId} openSidebarMenuKey={model.state.openSidebarMenuKey}
          setOpenSidebarMenuKey={model.state.setOpenSidebarMenuKey}
          renderExtras={{
            subtreeContainsEditing,
            menuOpenSessionId: model.state.openSidebarMenuKey === `session-menu:${row.key}` || model.state.openSidebarMenuKey === `session-context:${row.key}` ? row.node.session.id : null,
            nodeStructureKey: computeNodeStructureKey(row.node),
          }}
        />
      </div>;
    }
    if (row.kind === 'show-control') {
      return <button type="button" className="mt-0.5 flex items-center justify-start rounded-md pl-[26px] pr-1.5 py-0.5 text-left text-xs text-muted-foreground/70 leading-tight hover:text-foreground hover:underline" onClick={() => {
        if (row.containerKey.startsWith('activity:')) {
          model.state.setVisibleActivityCountByKey((current) => {
            const next = new Map(current);
            if (row.control === 'more') next.set(row.containerKey, row.currentCount + row.increment); else next.delete(row.containerKey);
            return next;
          });
        } else if (row.control === 'more') actions.group.showMoreGroupSessions(row.containerKey, row.currentCount, row.increment);
        else actions.group.resetGroupSessionLimit(row.containerKey);
      }}>{t(row.control === 'more' ? 'sessions.sidebar.group.showMore' : 'sessions.sidebar.group.showFewer')}</button>;
    }
    if (row.kind === 'status') return renderStatus(row);
    if (row.emptyKind === 'sidebar') return model.emptyState;
    if (row.emptyKind === 'search') return model.searchEmptyState;
    return <div className="py-1 pl-[26px] text-left typography-micro text-muted-foreground">
      {row.emptyKind === 'archived' ? t('sessions.sidebar.group.empty.noArchivedSessions') : row.group?.emptyMessage ?? t('sessions.sidebar.group.empty.noSessionsInWorkspace')}
    </div>;
  }, [actions, deleteFolder, model, projectPickerOptions, renameFolder, renderStatus, showDeletionDialog, t, toggleFolderCollapse, view]);

  const sticky = model.rowModel.stickyHeaders.find((descriptor) => `${descriptor.kind}:${descriptor.id}` === stickyIdentity) ?? null;
  const stickyRow = sticky ? model.rowModel.rows[sticky.rowIndex] : null;
  const structuralIds = React.useMemo(() => model.rowModel.rows.flatMap((row) => row.kind === 'project-header' ? [row.section.project.id] : row.kind === 'group-header' ? [row.groupKey] : []), [model.rowModel.rows]);

  return <div
    className="oc-sticky-fade-root relative flex min-h-0 flex-1"
    // SAFETY: React's style type does not declare application-owned CSS custom properties.
    style={enableStickyFade ? { '--scroll-shadow-top-size': '0px' } as React.CSSProperties : undefined}
    onPointerDownCapture={enableStickyFade ? blockObscuredInteraction : undefined}
    onClickCapture={enableStickyFade ? blockObscuredInteraction : undefined}
    onContextMenuCapture={enableStickyFade ? blockObscuredInteraction : undefined}
  >
    <ScrollableOverlay
      ref={setScrollElement} useScrollShadow hideTopScrollShadow={!enableStickyFade} scrollShadowSize={96}
      outerClassName="flex-1 min-h-0" className="oc-sidebar-scroller oc-sticky-fade-scroller pb-1 pl-2.5 pr-2 [overflow-anchor:none]"
      onScroll={enableStickyFade ? (event) => syncTopFade(event.currentTarget) : undefined}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => {
        if (!event.over) return;
        // SAFETY: session and folder payloads are created by the sidebar's draggable and droppable row components.
        const activeData = event.active.data.current as { type?: string; sessionId?: string; ownerKey?: string | null; archivedBucket?: boolean } | undefined;
        // SAFETY: session and folder payloads are created by the sidebar's draggable and droppable row components.
        const overData = event.over.data.current as { type?: string; folderId?: string; scopeKey?: string; ownerKey?: string | null } | undefined;
        if (activeData?.type === 'session' && activeData.sessionId && activeData.ownerKey && activeData.archivedBucket !== true && overData?.type === 'folder' && overData.folderId && overData.scopeKey && overData.ownerKey === activeData.ownerKey) {
          const dropTarget = model.rowModel.folderDropTargets.find((entry) => entry.folderId === overData.folderId && entry.scopeKey === overData.scopeKey && entry.ownerKey === activeData.ownerKey);
          const authority = model.rowModel.folderAuthorityByOwner.get(activeData.ownerKey);
          if (!dropTarget?.enabled || authority?.complete !== true) return;
          const store = useSessionFoldersStore.getState();
          for (const scopeKey of authority.scopeKeys) {
            if (scopeKey !== overData.scopeKey) store.removeSessionFromFolder(scopeKey, activeData.sessionId);
          }
          addSessionToFolder(overData.scopeKey, overData.folderId, activeData.sessionId);
          return;
        }
        if (view.hasSessionSearchQuery || model.state.editingId !== null || event.active.id === event.over.id) return;
        const activeId = String(event.active.id);
        const overId = String(event.over.id);
        const projectIds = model.sectionsForRender.map((section) => section.project.id);
        const projectFrom = projectIds.indexOf(activeId);
        const projectTo = projectIds.indexOf(overId);
        if (projectFrom >= 0 && projectTo >= 0 && view.projectSortOrder === 'manual') {
          actions.reorderProjects(projectFrom, projectTo);
          return;
        }
        const activeRow = model.rowModel.rows.find((row): row is Extract<SessionSidebarRow, { kind: 'group-header' }> => row.kind === 'group-header' && row.groupKey === activeId);
        const overRow = model.rowModel.rows.find((row): row is Extract<SessionSidebarRow, { kind: 'group-header' }> => row.kind === 'group-header' && row.groupKey === overId);
        if (!activeRow || !overRow || activeRow.projectId !== overRow.projectId || !activeRow.projectId) return;
        const section = model.sectionsForRender.find((entry) => entry.project.id === activeRow.projectId);
        if (!section) return;
        const from = section.groups.findIndex((group) => group.id === activeRow.group.id);
        const to = section.groups.findIndex((group) => group.id === overRow.group.id);
        if (from < 0 || to < 0) return;
        actions.setGroupOrderByProject((current) => new Map(current).set(activeRow.projectId!, arrayMove(section.groups, from, to).map((group) => group.id)));
      }}>
        <SortableContext items={structuralIds} strategy={verticalListSortingStrategy}>
          <SessionSidebarRows model={model.rowModel} scrollElement={scrollElement} pinnedRowIndexes={pinnedRowIndexes} renderRow={renderRow} onFirstVisibleIndexChange={handleFirstVisibleIndexChange} />
        </SortableContext>
      </DndContext>
    </ScrollableOverlay>
    {enableStickyFade && stickyRow ? <div className="oc-sticky-fade-overlay pointer-events-none absolute inset-x-0 top-0 z-30 flex items-center gap-1.5 py-1 pl-4 pr-5" data-sidebar-sticky-header="true" aria-hidden="true">
      {stickyRow.kind === 'project-header' ? <>
        <ProjectHeaderIdentity id={stickyRow.section.project.id} projectLabel={getProjectLabel(stickyRow.section.project, view.homeDirectory)} projectIcon={stickyRow.section.project.icon} projectColor={stickyRow.section.project.color} projectIconImage={stickyRow.section.project.iconImage} projectIconBackground={stickyRow.section.project.iconBackground} />
        <DirectoryActionIndicator directory={stickyRow.section.project.normalizedPath} className="ml-auto" />
      </> : stickyRow.kind === 'activity-header' ? <>
        <Icon name={stickyRow.activityKey === 'chats' ? 'chat-4' : 'history'} className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80" />
        <span className="truncate typography-ui-label font-semibold lowercase text-foreground">{t(stickyRow.activityKey === 'chats' ? 'sessions.sidebar.activity.chatsTitle' : 'sessions.sidebar.activity.recentTitle')}</span>
      </> : null}
    </div> : null}
    <FolderDeleteConfirmDialog value={folderDeleteConfirm} setValue={setFolderDeleteConfirm} onConfirm={() => {
      if (!folderDeleteConfirm) return;
      deleteFolder(folderDeleteConfirm.scopeKey, folderDeleteConfirm.folderId);
      setFolderDeleteConfirm(null);
    }} />
  </div>;
}

export const SessionProjectScroller = React.memo(SessionProjectScrollerComponent);
