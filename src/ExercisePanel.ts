import * as vscode from 'vscode'
import { Exercise, Assignment } from './api/models'
import { Biro3Client } from './api/Biro3Client'
import { log } from './extension'
// @ts-ignore
const marked: typeof import('marked') = require('marked')

export default class ExercisePanel {
    public static readonly viewType = 'exercise'

    public disposed: boolean
    private readonly panel: vscode.WebviewPanel
    private readonly extensionUri: vscode.Uri
    private readonly client: Biro3Client
    private readonly onDispose: () => void

    private exerciseId: number | null
    private lock: Promise<void>
    private disposables: Array<vscode.Disposable> = []

    public static create(extensionUri: vscode.Uri, client: Biro3Client, exerciseId: number, onDispose: () => void) {
        const panel = vscode.window.createWebviewPanel(
            ExercisePanel.viewType,
            `Exercise ${exerciseId}`,
            vscode.ViewColumn.Active,
            getWebviewOptions(extensionUri)
        )

        return new ExercisePanel(panel, extensionUri, client, exerciseId, onDispose)
    }

    constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, client: Biro3Client, exerciseId: number | null, onDispose: () => void) {
        this.disposed = false
        this.panel = panel
        this.extensionUri = extensionUri
        this.exerciseId = exerciseId
        this.lock = Promise.resolve()
        this.client = client
        this.onDispose = onDispose

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables)

        this.panel.onDidChangeViewState(async () => {
            if (this.panel.visible) {
                await this.update(true)
            }
        }, null, this.disposables)

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh-submissions':
                        if (this.exerciseId === null) { return }
                        log.debug(`Refreshing submissions for exercise webview ${exerciseId}`)
                        await this.client.withReauth(() => this.client.getExercise(this.exerciseId ?? 0))
                        await this.update(true)
                        return
                    case 'fetch-reports':
                        if (this.exerciseId === null) { return }
                        log.debug(`Refreshing reports for exercise webview ${exerciseId}`)
                        await this.client.withReauth(() => this.client.getReports(message.evaluationId))
                        await this.update(true)
                        return
                    case 'open-file':
                        if (this.exerciseId === null) { return }
                        vscode.commands.executeCommand('vscbiro.openSubmittedFile', message.submissionId, message.filename)
                        return
                }
            },
            null,
            this.disposables
        )
    }

    public deserialize(state: unknown) {
        log.debug(`Exercise webview deserialized`)
        this.panel.webview.options = getWebviewOptions(this.extensionUri)
    }

    public dispose() {
        this.disposed = true

        this.panel.dispose()

        while (this.disposables.length) {
            const x = this.disposables.pop()
            if (x) {
                x.dispose()
            }
        }

        this.onDispose()
    }

    public reveal(exerciseId?: number | undefined) {
        if (exerciseId === undefined) {
            log.debug(`Revealing exercise webview`)
            this.panel.reveal(vscode.ViewColumn.Beside)

            this.update(true)
        } else {
            log.debug(`Revealing exercise webview ${exerciseId}`)
            this.panel.reveal(vscode.ViewColumn.Beside)

            if (this.exerciseId !== exerciseId) {
                this.exerciseId = exerciseId
                this.update(true)
            }
        }
    }

    public async update(clearContent: boolean) {
        if (this.exerciseId === null) {
            return
        }
        log.debug(`Updating exercise webview ${this.exerciseId}`)
        await this.lock
        let unlock: () => void = () => {
            log.warn(`Failed to unlock`)
            this.lock = Promise.resolve()
        }
        this.lock = new Promise(v => unlock = v)

        try {
            if (clearContent) {
                this.panel.webview.html = `Loading ...`
            }

            const exercise = await this.client.withReauth(() => this.client.getExercise(this.exerciseId ?? 0))

            const tasks: Array<Promise<any>> = []
            let shouldRefreshLater = false
            for (const submission of exercise.submissions) {
                if (submission.status === "UNDER_EVALUATION") {
                    shouldRefreshLater = true
                }
                tasks.push(this.client.withReauth(async () => {
                    const v = await this.client.getSubmissionStatus(submission.submissionId)
                    if (!v.finished) {
                        shouldRefreshLater = true
                    }
                    return v
                }))
                tasks.push(this.client.withReauth(() => this.client.getSubmissionFiles(submission.submissionId)))
                for (const evaluation of submission.evaluations) {
                    tasks.push(this.client.withReauth(() => this.client.getReports(evaluation.evaluationId)))
                }
            }
            if (shouldRefreshLater) {
                log.debug(`Exercise webview will refresh later`)
            }
            Promise.allSettled(tasks)
                .then(() => {
                    if (shouldRefreshLater && this.exerciseId === exercise.assignedExerciseId) {
                        setTimeout(() => {
                            if (this.exerciseId === exercise.assignedExerciseId) {
                                for (const submission of exercise.submissions) {
                                    if (!this.client.submissionStatuses[submission.submissionId].finished) {
                                        delete this.client.submissionStatuses[submission.submissionId]
                                        for (const evaluation of submission.evaluations) {
                                            delete this.client.reports[evaluation.evaluationId]
                                        }
                                    }
                                    if (submission.status === "UNDER_EVALUATION") {
                                        delete this.client.exercises[exercise.assignedExerciseId]
                                    }
                                }
                                log.debug(`Exercise webview is automatically refreshing`)
                                this.update(false)
                            } else {
                                log.warn(`Exercise webview changed, will not refresh`)
                            }
                        }, 1000)
                        this.refreshHtml(exercise)
                    }
                })
                .catch(error => log.error(String(error)))

            this.panel.title = `${exercise.indexInTaskList}. ${exercise.displayName}`
            this.refreshHtml(exercise)
        } catch (error) {
            log.error(String(error))
        } finally {
            unlock()
        }
    }

    private refreshHtml(exercise: Exercise) {
        log.debug(`Refreshing exercise webview HTML`)

        let assignment: Assignment | null = null

        for (const element of Object.values(this.client.assignmentDetails).flat()) {
            if (element.exerciseStatuses.some(v => v.assignedExerciseId === exercise.assignedExerciseId)) {
                assignment = element.assignmentDetails
                break
            }
        }

        const nonce = getNonce()

        this.panel.webview.html =
            `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${this.panel.webview.cspSource}; img-src ${this.panel.webview.cspSource} https:; script-src 'nonce-${nonce}';">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<link href="${this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'reset.css'))}" rel="stylesheet">
				<link href="${this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'vscode.css'))}" rel="stylesheet">
				<link href="${this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'main.css'))}" rel="stylesheet">
				<title>Cat Coding</title>
			</head>
			<body>
				<h1>${exercise.indexInTaskList}. ${exercise.displayName} (${exercise.maxScore} pont)</h1>
                ${(() => {
                    if (!assignment) { return '' }

                    const startTime = Date.parse(assignment.startTime)
                    const endTime = Date.parse(assignment.endTime)
                    const now = Date.now()

                    if (now < startTime) {
                        return `
                            <div class="assignment-locked">
                                <h2>A feladat ${(startTime - now)} ms múlva lesz elérhető</h2>
                            </div>
                        `
                    } else if (now < endTime) {
                        return ''
                    } else {
                        return `
                            <div class="assignment-locked">
                                <h2>A feladat határideje lejárt!</h2>
                            </div>
                        `
                    }
                })()}
                <div class="debug">
                    <b>Típus:</b> ${exercise.type} <br>
                    <b>Nehézség:</b> ${exercise.difficultyLevel} <br>
                    <b>Fájlformátum:</b> ${exercise.expectedFileFormat} <br>
                </div>
				<div class="description">
					${marked.parse(exercise.description, { async: false })}
				</div>
				<h2>Feltöltések</h2>
				<div class="submissions">
					${exercise.submissions.map(v => `
						<div class="submission">
							<h3>${v.name} <span class="submission-score score ${v.score >= exercise.maxScore ? 'success' : v.score === 0 ? 'fail' : 'almost'}">${v.score} pont</span> <span>${v.status}</span> <span class="submission-time time" title=${new Date(Date.parse(v.submissionTime)).toString()}>${v.submissionTime}</span></h3>
							<div class="evaluations" id="evaluations">
								${v.evaluations.map(v => `
									${v.message}
									${this.client.reports[v.evaluationId] ? `<div class="reports">
										${this.client.reports[v.evaluationId].map(v => typeof v.content === 'string' ? `
											<pre class="report report-message">${v.content}</pre>
										` : `
											<div class="report">
												${v.content.report_type}<br>
												${v.content.tests.map(v => `
													<div>
														<h3>${v.name} - <span class="score ${v.score >= v.tests.reduce((a, b) => a + b.max, 0) ? 'success' : v.score === 0 ? 'fail' : 'almost'}">${v.score} pont</span></h3>
														<div>
															${v.tests.map(v => `
																<div>
																	<h4>${v.name} - <span class="score ${v.score >= v.max ? 'success' : v.score === 0 ? 'fail' : 'almost'}">${v.score}/${v.max} pont</span></h4>
																	${v.message ? `<pre class="report-message">${v.message}</pre>` : ''}
																</div>
															`).join('')}
														</div>
													</div>
												`).join('')}
											</div>
										`).join('')}
									</div>` : 'no reports'}
								`).join('')}
							</div>
                            ${this.client.submissionFiles[v.submissionId] ? `<div class="files">
                                ${this.client.submissionFiles[v.submissionId].map(w => `
                                    <div class="file">
                                        <span class="file-link" data-submission=${v.submissionId} data-filename="${w.filename}">${w.filename}</span>
                                    </div>
                                `).join('')}
                            </div>` : 'no files'}
						</div>
					`).reverse().join('')}
				</div>

				<script nonce="${nonce}" src="${this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'main.js'))}"></script>
			</body>
			</html>`
    }
}

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
    return {
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')],
        enableScripts: true,
    }
}

function getNonce() {
    let text = ''
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length))
    }
    return text
}
