import path from 'path'
import * as vscode from 'vscode'
import { Biro3Client } from './api/Biro3Client'
import { BiroExplorerProvider } from './BiroExplorerProvider'
import ExercisePanel from './ExercisePanel'

export let log: vscode.LogOutputChannel

export function activate(context: vscode.ExtensionContext) {
    log = vscode.window.createOutputChannel("Bíró 3 Debug", { log: true })


    const client = new Biro3Client()
    let selectedExerciseId: number | null = null
    let exercisePanel: ExercisePanel | null = null


    const exerciseStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0)
    exerciseStatusItem.hide()

    vscode.window.createTreeView('biro-courses', {
        treeDataProvider: new BiroExplorerProvider(client, context.extensionUri)
    })


    const onExerciseViewDispose = () => {
        selectedExerciseId = null
        vscode.commands.executeCommand("setContext", "vscbiro.allowSubmission", selectedExerciseId !== null)
        exerciseStatusItem.text = ''
        exerciseStatusItem.hide()
    }


    context.subscriptions.push(vscode.commands.registerCommand('vscbiro.selectExercise', async (exerciseId: number) => {
        try {
            if (exercisePanel && !exercisePanel.disposed) {
                exercisePanel.reveal(exerciseId)
            } else {
                exercisePanel = ExercisePanel.create(context.extensionUri, client, exerciseId, onExerciseViewDispose)
            }
            selectedExerciseId = exerciseId
            const exercise = await client.withReauth(() => client.getExercise(exerciseId))
            exerciseStatusItem.text = `${exercise.indexInTaskList}. ${exercise.displayName}`
            exerciseStatusItem.show()

            vscode.commands.executeCommand("setContext", "vscbiro.allowSubmission", selectedExerciseId !== null)
        } catch (error) {
            log.error(String(error))
        }
    }))

    context.subscriptions.push(vscode.commands.registerCommand('vscbiro.submit', async (fileUri: vscode.Uri) => {
        if (selectedExerciseId === null) {
            vscode.window.showErrorMessage(`Nincs kiválasztva feladat!`)
            return
        }
        const exercise = await client.getExercise(selectedExerciseId)
        const document = vscode.workspace.textDocuments.find(v => v.uri.path === fileUri.path && v.uri.query === fileUri.query && v.uri.scheme === fileUri.scheme && v.uri.fragment === fileUri.fragment && v.uri.authority === fileUri.authority)
        if (!document) {
            vscode.window.showErrorMessage(`File ${fileUri.toString()} not found`)
            return
        }
        if (document.isClosed) {
            vscode.window.showErrorMessage(`File ${fileUri.toString()} is closed`)
            return
        }
        if (!document.fileName.endsWith(`.${exercise.expectedFileFormat}`)) {
            const confirm = await vscode.window.showWarningMessage(`A fájl kiterjesztésnek .${exercise.expectedFileFormat} kell lennie. Biztosan feltöltöd?`, 'Igen', 'Nem')
            if (confirm !== 'Igen') {
                return
            }
        }
        log.debug(`Uploading file ...`)
        await client.submitFile(exercise.assignedExerciseId, path.basename(document.fileName), document.getText())
        delete client.exercises[exercise.assignedExerciseId]
        exercisePanel?.reveal(exercise.assignedExerciseId)
        log.debug(`File uploaded`)
    }))

    vscode.workspace.registerTextDocumentContentProvider('birosubmission', new class implements vscode.TextDocumentContentProvider {
        async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
            const submissionId = Number.parseInt(uri.query)
            const files = await client.withReauth(() => client.getSubmissionFiles(submissionId))
            for (const file of files) {
                if (file.filename === uri.path) {
                    return file.content
                }
            }
            vscode.window.showErrorMessage(`File ${uri.path} not found`)
            return ""
        }
    })

    context.subscriptions.push(vscode.commands.registerCommand('vscbiro.openSubmittedFile', async (submissionId: number, filename: string) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`birosubmission:${filename}?${submissionId}`))
        await vscode.window.showTextDocument(doc, { preview: true })
    }))

    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer(ExercisePanel.viewType, {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: unknown) {
                exercisePanel = new ExercisePanel(webviewPanel, context.extensionUri, client, null, onExerciseViewDispose)
                exercisePanel.deserialize(state)
            }
        })
    }
}

export function deactivate() {

}
