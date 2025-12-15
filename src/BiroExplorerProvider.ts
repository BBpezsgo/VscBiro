import * as vscode from 'vscode'
import { Biro3Client } from './api/Biro3Client'

export class BiroExplorerProvider implements vscode.TreeDataProvider<string> {
    readonly client: Biro3Client
    readonly extensionRoot: vscode.Uri

    constructor(client: Biro3Client, extensionRoot: vscode.Uri) {
        this.client = client
        this.extensionRoot = extensionRoot
    }

    private _onDidChangeTreeData = new vscode.EventEmitter<string | undefined>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
    refresh(): void { this._onDidChangeTreeData.fire(undefined) }

    getTreeItem(element: string): vscode.TreeItem {
        const parts = element.split('-')
        if (parts.length === 1) {
            const subjectInstanceId = Number.parseInt(parts[0])

            const subject = this.client.subjectInstances?.[subjectInstanceId]
            if (subject) {
                const item = new vscode.TreeItem(subject.subjectName, vscode.TreeItemCollapsibleState.Collapsed)
                item.description = `${subject.roomName} ${subject.startTime} - ${subject.endTime}`
                item.id = element
                item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'class.svg')
                return item
            }
        }

        if (parts.length === 2) {
            const subjectInstanceId = Number.parseInt(parts[0])
            const assignmentAssignedStudentId = Number.parseInt(parts[1])

            const assignment = this.client.assignments[subjectInstanceId]?.find(v => v.assignmentAssignedStudentId === assignmentAssignedStudentId)
            if (assignment) {
                const item = new vscode.TreeItem(assignment.assignmentName, vscode.TreeItemCollapsibleState.Collapsed)
                item.description = assignment.assignmentDescription
                item.id = element
                if (assignment.postDeadlineHandling === "LOCKED") {
                    item.collapsibleState = vscode.TreeItemCollapsibleState.None
                    item.tooltip = "This assignment is locked"
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'lock.svg')
                } else if (assignment.score === null) {
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'no-submission.svg')
                } else if (assignment.score >= assignment.maxScore) {
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'pass.svg')
                } else if (assignment.score > assignment.minScore) {
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'in-progress.svg')
                } else if (assignment.score < assignment.maxScore) {
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'error.svg')
                }
                return item
            }
        }

        if (parts.length === 3) {
            const assignmentAssignedStudentId = Number.parseInt(parts[1])
            const exerciseId = Number.parseInt(parts[2])

            const exercise = this.client.assignmentDetails[assignmentAssignedStudentId]?.exerciseStatuses.find(v => v.assignedExerciseId === exerciseId)
            if (exercise) {
                const item = new vscode.TreeItem(`${exercise.exerciseIndex}. feladat`, vscode.TreeItemCollapsibleState.Collapsed)
                item.id = element
                if (exercise.exerciseState === "COMPLETED") {
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'in-progress.svg')
                } else if (exercise.exerciseState === "MAX") {
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'pass.svg')
                } else if (exercise.exerciseState === "COMPLETED_ZERO") {
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'error.svg')
                } else if (exercise.exerciseState === "NO_SUBMISSION") {
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'no-submission.svg')
                } else {
                    item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'no-submission.svg')
                }
                item.command = {
                    command: "vscbiro.selectExercise",
                    arguments: [exerciseId],
                    title: "Show info",
                }
                return item
            }
        }

        return new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.Collapsed)
    }

    async getChildren(element?: string): Promise<string[]> {
        if (!element) {
            const subjectInstances = await this.client.withReauth(() => this.client.getSubjectInstances())
            return subjectInstances.map(v => `${v.subjectInstanceId}`)
        }

        const parts = element.split('-')

        if (parts.length === 1) {
            const subjectInstanceId = Number.parseInt(parts[0])

            const assignments = await this.client.withReauth(() => this.client.getAssignments(subjectInstanceId))
            return assignments.map(v => `${subjectInstanceId}-${v.assignmentAssignedStudentId}`) ?? []
        }

        if (parts.length === 2) {
            const subjectInstanceId = Number.parseInt(parts[0])
            const assignmentAssignedStudentId = Number.parseInt(parts[1])

            const assignment = await this.client.withReauth(() => this.client.getAssignment(assignmentAssignedStudentId))
            if (assignment.assignmentDetails.postDeadlineHandling === "LOCKED") {
                return Promise.resolve([])
            }
            return assignment.exerciseStatuses.map(v => `${subjectInstanceId}-${assignmentAssignedStudentId}-${v.assignedExerciseId}`)
        }

        return Promise.resolve([])
    }
}
