import { Disposable, Event, QuickDiffProvider, SourceControl, Uri, scm, workspace } from 'vscode';
import { NAMESPACE } from './constants';
import { GutterDiffBase } from './treeProvider';
import { API as GitAPI } from './typings/git';

const SETTING = 'showGutterDiff';
// Serves empty documents, used as the original of files that don't exist at the base,
// so that they are shown as entirely added.
const EMPTY_SCHEME = 'git-tree-compare-empty';
const REFRESH_DELAY_MS = 100;

export interface GutterDiffHost {
    readonly gitApi: GitAPI;
    readonly onDidChangeComparisons: Event<void>;
    resolveGutterDiffBase(absPath: string): GutterDiffBase | undefined;
    getGutterDiffState(): string;
}

/**
 * Shows VS Code's native gutter change indicators (quick diff) relative to the
 * comparison base, by registering a source control that only provides a quick
 * diff. It has no root URI, so it applies to files of all repositories and is
 * ordered after the Git extension's own quick diff provider.
 */
export class GutterDiffController implements Disposable {
    private sourceControl: SourceControl | undefined;
    private state = '';
    private refreshTimer: NodeJS.Timeout | undefined;
    private readonly disposables: Disposable[] = [];

    private readonly quickDiffProvider: QuickDiffProvider = {
        provideOriginalResource: (uri: Uri) => {
            if (uri.scheme !== 'file') {
                return undefined;
            }
            const base = this.host.resolveGutterDiffBase(uri.fsPath);
            if (!base) {
                return undefined;
            }
            if (base.isNew) {
                return Uri.from({ scheme: EMPTY_SCHEME, path: uri.path });
            }
            return this.host.gitApi.toGitUri(Uri.file(base.srcAbsPath), base.ref);
        },
    };

    constructor(private readonly host: GutterDiffHost) {
        this.disposables.push(
            workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, { provideTextDocumentContent: () => '' }),
            workspace.onDidChangeConfiguration(e => {
                if (e.affectsConfiguration(`${NAMESPACE}.${SETTING}`)) {
                    this.update();
                }
            }),
            host.onDidChangeComparisons(() => this.scheduleRefresh()),
        );
        this.update();
    }

    static async setEnabled(enabled: boolean) {
        await workspace.getConfiguration(NAMESPACE).update(SETTING, enabled, true);
    }

    private update() {
        const enabled = workspace.getConfiguration(NAMESPACE).get<boolean>(SETTING, false);
        if (enabled && !this.sourceControl) {
            const sourceControl = scm.createSourceControl(NAMESPACE, 'Git Tree Compare');
            // The entry can't be hidden with the stable API; its header has an info
            // button explaining why it is there.
            sourceControl.inputBox.visible = false;
            sourceControl.quickDiffProvider = this.quickDiffProvider;
            this.state = this.host.getGutterDiffState();
            this.sourceControl = sourceControl;
        } else if (!enabled && this.sourceControl) {
            this.clearRefreshTimer();
            this.sourceControl.dispose();
            this.sourceControl = undefined;
        }
    }

    private scheduleRefresh() {
        if (!this.sourceControl) {
            return;
        }
        this.clearRefreshTimer();
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = undefined;
            this.refresh();
        }, REFRESH_DELAY_MS);
    }

    private refresh() {
        const state = this.host.getGutterDiffState();
        if (!this.sourceControl || state === this.state) {
            return;
        }
        this.state = state;
        // VS Code only asks for the original resource again when something triggers
        // a re-diff. Re-registering the provider does that for all open editors.
        this.sourceControl.quickDiffProvider = undefined;
        this.sourceControl.quickDiffProvider = this.quickDiffProvider;
    }

    private clearRefreshTimer() {
        if (this.refreshTimer) {
            clearTimeout(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    dispose() {
        this.clearRefreshTimer();
        this.sourceControl?.dispose();
        this.sourceControl = undefined;
        this.disposables.forEach(d => d.dispose());
    }
}
