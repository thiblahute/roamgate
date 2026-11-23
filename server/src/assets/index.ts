/**
 * The files of contract/assets, as text: the scripts Roamgate runs on its
 * hosts and installs there, the login page, the rendered helper and the
 * voice model catalog. Both servers embed these same bytes
 * (contract/assets/README.md); `{{...}}` tags are filled by fillTemplate.
 */
import TOOL_CATALOG from "../../../contract/tools/catalog.json";
import VOICE_MODELS from "../../../contract/assets/data/voice-models.json";
import LOGIN_HTML_FILE from "../../../contract/assets/html/login.html" with {
  type: "text",
};
import RENDERED_HELPER_JS from "../../../contract/assets/js/rendered-helper.js" with {
  type: "text",
};
import HERDR_BRIDGE_PS1 from "../../../contract/assets/ps1/herdr-bridge.ps1" with {
  type: "text",
};
import HERDR_PROBE_PS1 from "../../../contract/assets/ps1/herdr-probe.ps1" with {
  type: "text",
};
import LIST_DIRECTORY_PS1 from "../../../contract/assets/ps1/list-directory.ps1" with {
  type: "text",
};
import TASK_STATUS_PS1 from "../../../contract/assets/ps1/task-status.ps1" with {
  type: "text",
};
import TASK_WAIT_STOPPED_PS1 from "../../../contract/assets/ps1/task-wait-stopped.ps1" with {
  type: "text",
};
import CLAUDE_START_HOOK_INSTALL_PY from "../../../contract/assets/python/claude-start-hook-install.py" with {
  type: "text",
};
import CODEX_SESSION_FIND_PY from "../../../contract/assets/python/codex-session-find.py" with {
  type: "text",
};
import EXCLUSIVE_RENAME_PY from "../../../contract/assets/python/exclusive-rename.py" with {
  type: "text",
};
import HERDR_RELAY_PY from "../../../contract/assets/python/herdr-relay.py" with {
  type: "text",
};
import ROAMGATE_HOLD_PY from "../../../contract/assets/python/roamgate-hold.py" with {
  type: "text",
};
import ROAMGATE_REVIEW_PY from "../../../contract/assets/python/roamgate-review.py" with {
  type: "text",
};
import BATCH_BLOCK_SH from "../../../contract/assets/sh/batch-block.sh" with {
  type: "text",
};
import BATCH_SH from "../../../contract/assets/sh/batch.sh" with {
  type: "text",
};
import CAPPED_DIFF_SH from "../../../contract/assets/sh/capped-diff.sh" with {
  type: "text",
};
import CLAUDE_SUCCESSOR_SH from "../../../contract/assets/sh/claude-successor.sh" with {
  type: "text",
};
import COMBINED_DIFF_SH from "../../../contract/assets/sh/combined-diff.sh" with {
  type: "text",
};
import COMPARE_REFS_SH from "../../../contract/assets/sh/compare-refs.sh" with {
  type: "text",
};
import DELETE_FILE_SH from "../../../contract/assets/sh/delete-file.sh" with {
  type: "text",
};
import DELETE_UNTRACKED_SH from "../../../contract/assets/sh/delete-untracked.sh" with {
  type: "text",
};
import DIFF_BASE_REFS_SH from "../../../contract/assets/sh/diff-base-refs.sh" with {
  type: "text",
};
import DIFF_BASE_RELATION_SH from "../../../contract/assets/sh/diff-base-relation.sh" with {
  type: "text",
};
import DOWNLOAD_FILE_SH from "../../../contract/assets/sh/download-file.sh" with {
  type: "text",
};
import FIND_SESSION_SH from "../../../contract/assets/sh/find-session.sh" with {
  type: "text",
};
import GIT_STATUS_BLOCK_SH from "../../../contract/assets/sh/git-status-block.sh" with {
  type: "text",
};
import HTML_PREVIEW_FILES_SH from "../../../contract/assets/sh/html-preview-files.sh" with {
  type: "text",
};
import LAST_STEP_REFS_SH from "../../../contract/assets/sh/last-step-refs.sh" with {
  type: "text",
};
import LIST_DIRECTORY_SH from "../../../contract/assets/sh/list-directory.sh" with {
  type: "text",
};
import LIST_FILES_SH from "../../../contract/assets/sh/list-files.sh" with {
  type: "text",
};
import MUTATE_FILE_SH from "../../../contract/assets/sh/mutate-file.sh" with {
  type: "text",
};
import PROCESS_CWDS_SH from "../../../contract/assets/sh/process-cwds.sh" with {
  type: "text",
};
import READ_FILE_SH from "../../../contract/assets/sh/read-file.sh" with {
  type: "text",
};
import READ_SESSION_TAIL_SH from "../../../contract/assets/sh/read-session-tail.sh" with {
  type: "text",
};
import REPO_INFO_BLOCK_SH from "../../../contract/assets/sh/repo-info-block.sh" with {
  type: "text",
};
import RESOLVE_FILES_SH from "../../../contract/assets/sh/resolve-files.sh" with {
  type: "text",
};
import SHELL_JOB_SH from "../../../contract/assets/sh/shell-job.sh" with {
  type: "text",
};
import SITE_ROOT_SH from "../../../contract/assets/sh/site-root.sh" with {
  type: "text",
};
import STAT_BATCH_SH from "../../../contract/assets/sh/stat-batch.sh" with {
  type: "text",
};
import STAT_FILE_SH from "../../../contract/assets/sh/stat-file.sh" with {
  type: "text",
};
import STAT_LOOP_SH from "../../../contract/assets/sh/stat-loop.sh" with {
  type: "text",
};
import STEP_SNAPSHOT_SH from "../../../contract/assets/sh/step-snapshot.sh" with {
  type: "text",
};
import UNTRACKED_NUMSTAT_SH from "../../../contract/assets/sh/untracked-numstat.sh" with {
  type: "text",
};
import UNTRACKED_STATS_SH from "../../../contract/assets/sh/untracked-stats.sh" with {
  type: "text",
};
import UPDATE_INSTALL_SH from "../../../contract/assets/sh/update-install.sh" with {
  type: "text",
};
import UPLOAD_CLEANUP_SH from "../../../contract/assets/sh/upload-cleanup.sh" with {
  type: "text",
};
import UPLOAD_FILE_SH from "../../../contract/assets/sh/upload-file.sh" with {
  type: "text",
};
import UPLOAD_WRITE_SH from "../../../contract/assets/sh/upload-write.sh" with {
  type: "text",
};
import WORKTREE_STATE_SH from "../../../contract/assets/sh/worktree-state.sh" with {
  type: "text",
};
import REVIEW_SKILL_MD from "../../../contract/assets/skill/SKILL.md" with {
  type: "text",
};

/** bun-types declares *.html as an HTML bundle; a text import is a string. */
const LOGIN_HTML_TEMPLATE = LOGIN_HTML_FILE as unknown as string;

export { fillTemplate, templateNames } from "./template";

/**
 * The Claude mod's name in its requests (`via`), a constant of the tool
 * catalog (contract/tools/catalog.json), which the mod reads too.
 */
export const MOD_VIA: string = TOOL_CATALOG.constants.MOD_VIA;
export {
  VOICE_MODELS,
  LOGIN_HTML_TEMPLATE,
  RENDERED_HELPER_JS,
  HERDR_BRIDGE_PS1,
  HERDR_PROBE_PS1,
  LIST_DIRECTORY_PS1,
  TASK_STATUS_PS1,
  TASK_WAIT_STOPPED_PS1,
  CLAUDE_START_HOOK_INSTALL_PY,
  CODEX_SESSION_FIND_PY,
  EXCLUSIVE_RENAME_PY,
  HERDR_RELAY_PY,
  ROAMGATE_HOLD_PY,
  ROAMGATE_REVIEW_PY,
  BATCH_BLOCK_SH,
  BATCH_SH,
  CAPPED_DIFF_SH,
  CLAUDE_SUCCESSOR_SH,
  COMBINED_DIFF_SH,
  COMPARE_REFS_SH,
  DELETE_FILE_SH,
  DELETE_UNTRACKED_SH,
  DIFF_BASE_REFS_SH,
  DIFF_BASE_RELATION_SH,
  DOWNLOAD_FILE_SH,
  FIND_SESSION_SH,
  GIT_STATUS_BLOCK_SH,
  HTML_PREVIEW_FILES_SH,
  LAST_STEP_REFS_SH,
  LIST_DIRECTORY_SH,
  LIST_FILES_SH,
  MUTATE_FILE_SH,
  PROCESS_CWDS_SH,
  READ_FILE_SH,
  READ_SESSION_TAIL_SH,
  REPO_INFO_BLOCK_SH,
  RESOLVE_FILES_SH,
  SHELL_JOB_SH,
  SITE_ROOT_SH,
  STAT_BATCH_SH,
  STAT_FILE_SH,
  STAT_LOOP_SH,
  STEP_SNAPSHOT_SH,
  UNTRACKED_NUMSTAT_SH,
  UNTRACKED_STATS_SH,
  UPDATE_INSTALL_SH,
  UPLOAD_CLEANUP_SH,
  UPLOAD_FILE_SH,
  UPLOAD_WRITE_SH,
  WORKTREE_STATE_SH,
  REVIEW_SKILL_MD,
};

/** Every text asset by its path under contract/assets (tests). */
export const ASSET_TEXTS: Record<string, string> = {
  "html/login.html": LOGIN_HTML_TEMPLATE,
  "js/rendered-helper.js": RENDERED_HELPER_JS,
  "ps1/herdr-bridge.ps1": HERDR_BRIDGE_PS1,
  "ps1/herdr-probe.ps1": HERDR_PROBE_PS1,
  "ps1/list-directory.ps1": LIST_DIRECTORY_PS1,
  "ps1/task-status.ps1": TASK_STATUS_PS1,
  "ps1/task-wait-stopped.ps1": TASK_WAIT_STOPPED_PS1,
  "python/claude-start-hook-install.py": CLAUDE_START_HOOK_INSTALL_PY,
  "python/codex-session-find.py": CODEX_SESSION_FIND_PY,
  "python/exclusive-rename.py": EXCLUSIVE_RENAME_PY,
  "python/herdr-relay.py": HERDR_RELAY_PY,
  "python/roamgate-hold.py": ROAMGATE_HOLD_PY,
  "python/roamgate-review.py": ROAMGATE_REVIEW_PY,
  "sh/batch-block.sh": BATCH_BLOCK_SH,
  "sh/batch.sh": BATCH_SH,
  "sh/capped-diff.sh": CAPPED_DIFF_SH,
  "sh/claude-successor.sh": CLAUDE_SUCCESSOR_SH,
  "sh/combined-diff.sh": COMBINED_DIFF_SH,
  "sh/compare-refs.sh": COMPARE_REFS_SH,
  "sh/delete-file.sh": DELETE_FILE_SH,
  "sh/delete-untracked.sh": DELETE_UNTRACKED_SH,
  "sh/diff-base-refs.sh": DIFF_BASE_REFS_SH,
  "sh/diff-base-relation.sh": DIFF_BASE_RELATION_SH,
  "sh/download-file.sh": DOWNLOAD_FILE_SH,
  "sh/find-session.sh": FIND_SESSION_SH,
  "sh/git-status-block.sh": GIT_STATUS_BLOCK_SH,
  "sh/html-preview-files.sh": HTML_PREVIEW_FILES_SH,
  "sh/last-step-refs.sh": LAST_STEP_REFS_SH,
  "sh/list-directory.sh": LIST_DIRECTORY_SH,
  "sh/list-files.sh": LIST_FILES_SH,
  "sh/mutate-file.sh": MUTATE_FILE_SH,
  "sh/process-cwds.sh": PROCESS_CWDS_SH,
  "sh/read-file.sh": READ_FILE_SH,
  "sh/read-session-tail.sh": READ_SESSION_TAIL_SH,
  "sh/repo-info-block.sh": REPO_INFO_BLOCK_SH,
  "sh/resolve-files.sh": RESOLVE_FILES_SH,
  "sh/shell-job.sh": SHELL_JOB_SH,
  "sh/site-root.sh": SITE_ROOT_SH,
  "sh/stat-batch.sh": STAT_BATCH_SH,
  "sh/stat-file.sh": STAT_FILE_SH,
  "sh/stat-loop.sh": STAT_LOOP_SH,
  "sh/step-snapshot.sh": STEP_SNAPSHOT_SH,
  "sh/untracked-numstat.sh": UNTRACKED_NUMSTAT_SH,
  "sh/untracked-stats.sh": UNTRACKED_STATS_SH,
  "sh/update-install.sh": UPDATE_INSTALL_SH,
  "sh/upload-cleanup.sh": UPLOAD_CLEANUP_SH,
  "sh/upload-file.sh": UPLOAD_FILE_SH,
  "sh/upload-write.sh": UPLOAD_WRITE_SH,
  "sh/worktree-state.sh": WORKTREE_STATE_SH,
  "skill/SKILL.md": REVIEW_SKILL_MD,
};
