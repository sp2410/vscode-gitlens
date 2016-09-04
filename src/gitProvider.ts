'use strict'
import {Disposable, ExtensionContext, Location, Position, Range, Uri, workspace} from 'vscode';
import {DocumentSchemes, WorkspaceState} from './constants';
import Git from './git';
import {basename, dirname, extname} from 'path';
import * as moment from 'moment';
import * as _ from 'lodash';

const blameMatcher = /^([\^0-9a-fA-F]{8})\s([\S]*)\s+([0-9\S]+)\s\((.*)\s([0-9]{4}-[0-9]{2}-[0-9]{2}\s[0-9]{2}:[0-9]{2}:[0-9]{2}\s[-|+][0-9]{4})\s+([0-9]+)\)(.*)$/gm;
const commitMessageMatcher = /^([\^0-9a-fA-F]{7})\s(.*)$/gm;

export default class GitProvider extends Disposable {
    public repoPath: string;

    private _blames: Map<string, Promise<IGitBlame>>;
    private _subscription: Disposable;

    constructor(context: ExtensionContext) {
        super(() => this.dispose());

        this.repoPath = context.workspaceState.get(WorkspaceState.RepoPath) as string;

        this._blames = new Map();
        this._subscription = Disposable.from(
            workspace.onDidCloseTextDocument(d => this._removeFile(d.fileName)),
            // TODO: Need a way to reset codelens in response to a save
            workspace.onDidSaveTextDocument(d => this._removeFile(d.fileName))
            //workspace.onDidChangeTextDocument(e => this._removeFile(e.document.fileName))
        );
    }

    dispose() {
        this._blames.clear();
        this._subscription && this._subscription.dispose();
    }

    private _removeFile(fileName: string) {
        fileName = Git.normalizePath(fileName, this.repoPath);
        this._blames.delete(fileName);
    }

    getRepoPath(cwd: string) {
        return Git.repoPath(cwd);
    }

    getBlameForFile(fileName: string) {
        fileName = Git.normalizePath(fileName, this.repoPath);

        let blame = this._blames.get(fileName);
        if (blame !== undefined) return blame;

        blame = Git.blame(fileName, this.repoPath)
            .then(data => {
                const authors: Map<string, IGitAuthor> = new Map();
                const commits: Map<string, IGitCommit> = new Map();
                const lines: Array<IGitCommitLine> = [];

                let m: Array<string>;
                while ((m = blameMatcher.exec(data)) != null) {
                    const authorName = m[4].trim();
                    let author = authors.get(authorName);
                    if (!author) {
                        author = {
                            name: authorName,
                            lineCount: 0
                        };
                        authors.set(authorName, author);
                    }

                    const sha = m[1];
                    let commit = commits.get(sha);
                    if (!commit) {
                        commit = {
                            sha,
                            fileName: fileName,
                            author: m[4].trim(),
                            date: new Date(m[5]),
                            lines: []
                        };
                        commits.set(sha, commit);
                    }

                    const line: IGitCommitLine = {
                        sha,
                        line: parseInt(m[6], 10) - 1,
                        originalLine: parseInt(m[3], 10) - 1
                        //code: m[7]
                    }

                    const file = m[2].trim();
                    if (!fileName.toLowerCase().endsWith(file.toLowerCase())) {
                        line.originalFileName = file;
                    }

                    commit.lines.push(line);
                    lines.push(line);
                }

                commits.forEach(c => authors.get(c.author).lineCount += c.lines.length);

                const sortedAuthors: Map<string, IGitAuthor> = new Map();
                const values = Array.from(authors.values())
                    .sort((a, b) => b.lineCount - a.lineCount)
                    .forEach(a => sortedAuthors.set(a.name, a));

                const sortedCommits = new Map();
                Array.from(commits.values())
                    .sort((a, b) => b.date.getTime() - a.date.getTime())
                    .forEach(c => sortedCommits.set(c.sha, c));

                return {
                    authors: sortedAuthors,
                    commits: sortedCommits,
                    lines: lines
                };
            });

        this._blames.set(fileName, blame);
        return blame;
    }

    getBlameForLine(fileName: string, line: number): Promise<IGitBlameLine> {
        return this.getBlameForFile(fileName).then(blame => {
            const blameLine = blame.lines[line];
            const commit = blame.commits.get(blameLine.sha);
            return {
                author: Object.assign({}, blame.authors.get(commit.author), { lineCount: commit.lines.length }),
                commit: commit,
                line: blameLine
            };
        });
    }

    getBlameForRange(fileName: string, range: Range): Promise<IGitBlame> {
        return this.getBlameForFile(fileName).then(blame => {
            if (!blame.lines.length) return blame;

            if (range.start.line === 0 && range.end.line === blame.lines.length - 1) {
                return blame;
            }

            const lines = blame.lines.slice(range.start.line, range.end.line + 1);
            const shas: Set<string> = new Set();
            lines.forEach(l => shas.add(l.sha));

            const authors: Map<string, IGitAuthor> = new Map();
            const commits: Map<string, IGitCommit> = new Map();
            blame.commits.forEach(c => {
                if (!shas.has(c.sha)) return;

                const commit: IGitCommit = Object.assign({}, c, { lines: c.lines.filter(l => l.line >= range.start.line && l.line <= range.end.line) });
                commits.set(c.sha, commit);

                let author = authors.get(commit.author);
                if (!author) {
                    author = {
                        name: commit.author,
                        lineCount: 0
                    };
                    authors.set(author.name, author);
                }

                author.lineCount += commit.lines.length;
            });

            const sortedAuthors = new Map();
            Array.from(authors.values())
                .sort((a, b) => b.lineCount - a.lineCount)
                .forEach(a => sortedAuthors.set(a.name, a));

            return { authors: sortedAuthors, commits, lines };
        });
    }

    getBlameForShaRange(fileName: string, sha: string, range: Range): Promise<IGitBlameLines> {
        return this.getBlameForFile(fileName).then(blame => {
            const lines = blame.lines.slice(range.start.line, range.end.line + 1).filter(l => l.sha === sha);
            const commit = Object.assign({}, blame.commits.get(sha), { lines: lines });
            return {
                author: Object.assign({}, blame.authors.get(commit.author), { lineCount: commit.lines.length }),
                commit: commit,
                lines: lines
            };
        });
    }

    getBlameLocations(fileName: string, range: Range) {
        return this.getBlameForRange(fileName, range).then(blame => {
            const commitCount = blame.commits.size;

            const locations: Array<Location> = [];
            Array.from(blame.commits.values())
                .forEach((c, i) => {
                    const uri = this.toBlameUri(c, i + 1, commitCount, range);
                    c.lines.forEach(l => locations.push(new Location(l.originalFileName
                            ? this.toBlameUri(c, i + 1, commitCount, range, l.originalFileName)
                            : uri,
                        new Position(l.originalLine, 0))));
                });

            return locations;
        });
    }

    getCommitMessage(sha: string) {
        return Git.getCommitMessage(sha, this.repoPath);
    }

    getCommitMessages(fileName: string) {
        return Git.getCommitMessages(fileName, this.repoPath).then(data => {
            const commits: Map<string, string> = new Map();
            let m: Array<string>;
            while ((m = commitMessageMatcher.exec(data)) != null) {
                commits.set(m[1], m[2]);
            }

            return commits;
        });
    }

    getVersionedFile(fileName: string, sha: string) {
        return Git.getVersionedFile(fileName, this.repoPath, sha);
    }

    getVersionedFileText(fileName: string, sha: string) {
        return Git.getVersionedFileText(fileName, this.repoPath, sha);
    }

    fromBlameUri(uri: Uri): IGitBlameUriData {
        if (uri.scheme !== DocumentSchemes.GitBlame) throw new Error(`fromGitUri(uri=${uri}) invalid scheme`);
        const data = this._fromGitUri<IGitBlameUriData>(uri);
        data.range = new Range(data.range[0].line, data.range[0].character, data.range[1].line, data.range[1].character);
        return data;
    }

    fromGitUri(uri: Uri) {
        if (uri.scheme !== DocumentSchemes.Git) throw new Error(`fromGitUri(uri=${uri}) invalid scheme`);
        return this._fromGitUri<IGitUriData>(uri);
    }

    private _fromGitUri<T extends IGitUriData>(uri: Uri): T {
        return JSON.parse(uri.query) as T;
    }

    toBlameUri(commit: IGitCommit, index: number, commitCount: number, range: Range, originalFileName?: string) {
        return this._toGitUri(DocumentSchemes.GitBlame, commit, commitCount, this._toGitBlameUriData(commit, index, range, originalFileName));
    }

    toGitUri(commit: IGitCommit, index: number, commitCount: number, originalFileName?: string) {
        return this._toGitUri(DocumentSchemes.Git, commit, commitCount, this._toGitUriData(commit, index, originalFileName));
    }

    private _toGitUri(scheme: DocumentSchemes, commit: IGitCommit, commitCount: number, data: IGitUriData | IGitBlameUriData) {
        const pad = n => ("0000000" + n).slice(-("" + commitCount).length);
        const ext = extname(data.fileName);
        const path = `${dirname(data.fileName)}/${commit.sha}: ${basename(data.fileName, ext)}${ext}`;

        // NOTE: Need to specify an index here, since I can't control the sort order -- just alphabetic or by file location
        return Uri.parse(`${scheme}:${pad(data.index)}. ${commit.author}, ${moment(commit.date).format('MMM D, YYYY hh:MM a')} - ${path}?${JSON.stringify(data)}`);
    }

    private _toGitUriData<T extends IGitUriData>(commit: IGitCommit, index: number, originalFileName?: string): T {
        const fileName = originalFileName || commit.fileName;
        const data = { fileName: commit.fileName, sha: commit.sha, index: index } as T;
        if (originalFileName) {
            data.originalFileName = originalFileName;
        }
        return data;
    }

    private _toGitBlameUriData(commit: IGitCommit, index: number, range: Range, originalFileName?: string) {
        const data = this._toGitUriData<IGitBlameUriData>(commit, index, originalFileName);
        data.range = range;
        return data;
    }
}

export interface IGitBlame {
    authors: Map<string, IGitAuthor>;
    commits: Map<string, IGitCommit>;
    lines: IGitCommitLine[];
}

export interface IGitBlameLine {
    author: IGitAuthor;
    commit: IGitCommit;
    line: IGitCommitLine;
}

export interface IGitBlameLines {
    author: IGitAuthor;
    commit: IGitCommit;
    lines: IGitCommitLine[];
}

export interface IGitAuthor {
    name: string;
    lineCount: number;
}

export interface IGitCommit {
    sha: string;
    fileName: string;
    author: string;
    date: Date;
    lines: IGitCommitLine[];
    message?: string;
}

export interface IGitCommitLine {
    sha: string;
    line: number;
    originalLine: number;
    originalFileName?: string;
    code?: string;
}

export interface IGitUriData {
    fileName: string,
    originalFileName?: string;
    sha: string,
    index: number
}

export interface IGitBlameUriData extends IGitUriData {
    range: Range
}