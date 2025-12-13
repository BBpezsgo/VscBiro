import * as vscode from 'vscode'
// @ts-ignore
const marked: typeof import('marked') = require('marked')

class ApiError extends Error {
    readonly status: number
    readonly statusMessage: string
    readonly response: any

    private constructor(status: number, statusMessage: string, response: any, message: string) {
        super(message)
        this.status = status
        this.statusMessage = statusMessage
        this.response = response
    }

    static async fromResponse(response: Response): Promise<ApiError> {
        const contentType = response.headers.get('content-type')
        let message = null
        let res: any = null
        try {
            if (contentType === "application/json") {
                const d = res = await response.json()
                if (d && typeof d === 'object' && 'message' in d) {
                    message = String(d['message'])
                }
            } else {
                message = res = await response.text()
            }
        } catch (error) {

        }
        if (message) {
            message = `HTTP ${response.status}: ${message}`
        } else if (response.statusText) {
            message = `HTTP ${response.status}: ${response.statusText}`
        } else {
            message = `HTTP ${response.status}`
        }
        return new ApiError(response.status, response.statusText, res, message)
    }
}

type SubjectInstance = {
    subjectInstanceId: number
    courseId: number
    subjectCode: string
    subjectName: string
    semesterName: string
    courseCode: string
    courseDay: string
    startTime: string
    endTime: string
    roomName: string
}

type Assignment = {
    assignmentAssignedStudentId: number
    startTime: string
    endTime: string
    assignmentName: string
    assignmentDescription: string
    assignmentType: string
    maxScore: number
    minScore: number
    score: number | null
    subjectName: string
    semesterName: string
    studentGroupName: unknown
    studentGroupMembers: unknown
    subjectInstanceId: number
    postDeadlineHandling: "VIEW_ONLY" | "LOCKED" | "SUBMIT_WITH_NO_POINTS"
}

type AssignmentDetails = {
    assignmentAssignedStudentId: number
    startTime: string
    endTime: string
    assignmentName: string
    assignmentDescription: string
    assignmentType: string
    maxScore: number
    minScore: number
    score: null
    subjectName: string
    semesterName: string
    studentGroupName: null
    studentGroupMembers: null
    subjectInstanceId: number
    postDeadlineHandling: string
}

type ExerciseStatus = {
    assignedExerciseId: number
    exerciseIndex: number
    exerciseState: "NO_SUBMISSION" | "COMPLETED" | "MAX" | "COMPLETED_ZERO"
}

type Exercise = {
    assignedExerciseId: number
    indexInTaskList: number
    type: string
    name: string
    displayName: string
    description: string
    difficultyLevel: number
    maxScore: number
    minScore: number
    uploadLimit: number
    expectedFileFormat: string
    timeLimit: null
    starterFiles: {
        starterFileId: number
        filename: string
        viewable: boolean
        copyable: boolean
        downloadable: boolean
    }[]
    taskImages: never[]
    tags: never[]
    score: number
    submissions: Submission[]
}

type Submission = {
    submissionId: number
    name: string
    score: number
    status: string
    submissionTime: string
    ipAddress: string
    evaluations: {
        evaluationId: number
        score: number
        message: string
        evaluationTime: string
    }[]
}

type SubmissionStatus = {
    state: "ERROR" | string
    finished: boolean
    score: number
    maxScore: number
    evaluationId: number
}

type ReportContent = {
    report_type: string
    tests: {
        name: string
        tests: {
            name: string
            score: number
            max: number
            message: string
        }[]
        score: number
    }[]
}

function sleep(ms: number): Promise<void> { return new Promise(v => setTimeout(v, ms)) }

class Biro3Client {
    username: string | null
    password: string | null
    accessToken: string | null
    refreshToken: string | null

    subjectInstances: Record<number, SubjectInstance> | null
    assignments: Record<number, ReadonlyArray<Assignment>>
    assignmentDetails: Record<number, { assignmentDetails: AssignmentDetails; exerciseStatuses: ReadonlyArray<ExerciseStatus>; }>
    exercises: Record<number, Exercise>
    submissionStatuses: Record<number, SubmissionStatus>
    reports: Record<number, ReadonlyArray<{ filename: string; content: string | ReportContent }>>
    submissionFiles: Record<number, ReadonlyArray<{ filename: string; content: string; }>>

    constructor() {
        this.username = null
        this.password = null
        this.accessToken = null
        this.refreshToken = null
        this.subjectInstances = null
        this.assignments = {}
        this.assignmentDetails = {}
        this.exercises = {}
        this.submissionStatuses = {}
        this.reports = {}
        this.submissionFiles = {}
    }

    private static parseCookies(response: Response): Readonly<Record<string, string>> {
        const cookies: Record<string, string> = {}
        for (const setCookie of response.headers.getSetCookie()) {
            const cookieName = setCookie.split('=')[0]
            const cookieValue = setCookie.substring(cookieName.length + 1).split(';')[0]
            cookies[cookieName] = cookieValue
        }
        return cookies
    }

    private static listToRecord<K extends string | number, T>(items: ReadonlyArray<T>, key: (item: T) => K): Record<K, T> {
        const res: Record<any, T> = {}
        for (const item of items) {
            res[key(item)] = item
        }
        return res
    }

    async fetchAccessToken(username: string, password: string): Promise<void> {
        this.refreshToken = null
        this.accessToken = null

        const res = await this.post('https://biro3.inf.u-szeged.hu/api/v1/auth/login/student', {
            username: username,
            password: password,
        })

        this.username = username
        this.password = password

        const d: any = await res.json()
        this.accessToken = d['accessToken']
    }

    async refreshAccessToken() {
        this.accessToken = null

        const res = await this.post('https://biro3.inf.u-szeged.hu/api/v1/auth/refresh-token', {
            withCredentials: true
        })

        const d: any = await res.json()
        this.accessToken = d['accessToken']
    }

    async withReauth<TResult>(fetch: () => Promise<TResult>): Promise<TResult> {
        if (!this.username || !this.password) {
            log.warn(`No username/password, asking the user ...`)
            await this.login()
        }

        if (!this.accessToken && this.username && this.password) {
            log.warn(`No access token, logging in again ...`)
            await this.fetchAccessToken(this.username, this.password)
        }

        let retries = 0
        do {
            try {
                return await fetch()
            } catch (error) {
                if (error instanceof ApiError) {
                    if (error.status === 401) {
                        log.warn(`Trying to handle API error: (${retries}) ${error}`)
                        switch (retries++) {
                            case 0:
                                log.warn(`Refreshing access token ...`)
                                try {
                                    await this.refreshAccessToken()
                                } catch (error) {
                                    log.error(String(error))
                                }
                                continue
                            case 1:
                                if (this.username && this.password) {
                                    log.warn(`Logging in again ...`)
                                    try {
                                        await this.fetchAccessToken(this.username, this.password)
                                    } catch (error) {
                                        log.error(String(error))
                                    }
                                    continue
                                }
                                break
                            default:
                                break
                        }
                    } else {
                        log.warn(error.status.toString())
                    }
                } else {
                    log.warn(Object.getPrototypeOf(error))
                }
                throw error
            }
        } while (true)
    }

    async getJson<T>(url: string): Promise<T> {
        const res = await this.get(url)
        const d: any = await res.json()
        return d
    }

    async get(url: string): Promise<Response> {
        log.debug(`GET ${url}`)

        let headers: Record<string, string> = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Sec-GPC': '1',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
        }

        if (this.accessToken) {
            headers['Authorization'] = `Bearer ${this.accessToken}`
        }

        if (this.refreshToken) {
            headers['Cookie'] = `refresh-token=${this.refreshToken}`
        }

        const res = await fetch(url, {
            credentials: 'include',
            headers: headers,
            method: 'GET',
            mode: 'cors'
        })

        if (!res.ok) {
            throw await ApiError.fromResponse(res)
        }

        this.refreshToken = Biro3Client.parseCookies(res)['refresh-token'] ?? this.refreshToken

        return res
    }

    async post(url: string, body: any): Promise<Response> {
        return await this.postRaw(url, JSON.stringify(body), {})
    }

    async postRaw(url: string, body: string, headers: Record<string, string>): Promise<Response> {
        log.debug(`POST ${url}\n${body}`)

        let _headers: Record<string, string> = {
            'Accept': 'application/json, text/plain, */*',
            'Accept-Language': 'en-US,en;q=0.5',
            'Content-Type': 'application/json',
            'Sec-GPC': '1',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-origin',
        }

        if (this.accessToken) {
            _headers['Authorization'] = `Bearer ${this.accessToken}`
        }

        if (this.refreshToken) {
            _headers['Cookie'] = `refresh-token=${this.refreshToken}`
        }

        const res = await fetch(url, {
            credentials: 'include',
            headers: {
                ..._headers,
                ...headers,
            },
            body: body,
            method: 'POST',
            mode: 'cors'
        })

        if (!res.ok) {
            throw await ApiError.fromResponse(res)
        }

        this.refreshToken = Biro3Client.parseCookies(res)['refresh-token'] ?? this.refreshToken

        return res
    }

    async getSubjectInstance(instanceId: number) {
        return this.subjectInstances?.[instanceId] ?? (await this.fetchSubjectInstances())[instanceId]
    }

    async getSubjectInstances() {
        return this.subjectInstances ? Object.values(this.subjectInstances) : await this.fetchSubjectInstances()
    }

    async fetchSubjectInstances() {
        const v = await this.getJson<ReadonlyArray<SubjectInstance>>('https://biro3.inf.u-szeged.hu/api/v1/students/subject-instances')
        this.subjectInstances = Biro3Client.listToRecord(v, v => v.subjectInstanceId)
        return v
    }

    async getAssignments(subjectId: number) {
        return this.assignments[subjectId] ?? await this.fetchAssignments(subjectId)
    }

    async fetchAssignments(subjectId: number) {
        const v = await this.getJson<ReadonlyArray<Assignment>>(`https://biro3.inf.u-szeged.hu/api/v1/students/subject-instances/${subjectId}/assignments`)
        this.assignments[subjectId] = v
        return v
    }

    async getAssignment(assignmentId: number) {
        return this.assignmentDetails[assignmentId] ?? await this.fetchAssignment(assignmentId)
    }

    async fetchAssignment(assignmentId: number) {
        const v = await this.getJson<{ assignmentDetails: AssignmentDetails, exerciseStatuses: ReadonlyArray<ExerciseStatus> }>(`https://biro3.inf.u-szeged.hu/api/v1/students/assignments/${assignmentId}`)
        this.assignmentDetails[assignmentId] = v
        return v
    }

    async getExercise(exerciseId: number) {
        return this.exercises[exerciseId] ?? await this.fetchExercise(exerciseId)
    }

    async fetchExercise(exerciseId: number) {
        const v = await this.getJson<Exercise>(`https://biro3.inf.u-szeged.hu/api/v1/students/exercises/${exerciseId}`)
        this.exercises[exerciseId] = v
        return v
    }

    async login() {
        do {
            const usernameInput: string = await vscode.window.showInputBox({
                password: false,
                title: 'Username',
                ignoreFocusOut: true,
            }) ?? ''
            const passwordInput: string = await vscode.window.showInputBox({
                password: true,
                title: 'Password',
                ignoreFocusOut: true,
            }) ?? ''

            try {
                return await this.fetchAccessToken(usernameInput, passwordInput)
            } catch (error) {
                log.error(String(error))
                if (error instanceof ApiError) {
                    const choice = await vscode.window.showErrorMessage(error.response['message'], "Újra")
                    if (choice === "Újra") continue
                }
                throw error
            }
        } while (true)
    }

    async submitFile(exerciseId: number, filename: string, filecontent: string): Promise<{ id: number }> {
        const builder = {
            value: "",
            appendLine: function (line: string = "") {
                this.value += line + "\r\n"
            }
        }

        const boundary = "----geckoformboundary273ffe305e9d16e6289195cb1b17216e"

        builder.appendLine(`--${boundary}`)
        builder.appendLine("Content-Disposition: form-data; name=\"submissionName\"")
        builder.appendLine()
        builder.appendLine()
        builder.appendLine(`--${boundary}`)
        builder.appendLine("Content-Disposition: form-data; name=\"post-deadline-submission-confirmed\"")
        builder.appendLine()
        builder.appendLine("false")
        builder.appendLine(`--${boundary}`)
        builder.appendLine(`Content-Disposition: form-data; name=\"file\"; filename=${JSON.stringify(filename)}`)
        builder.appendLine("Content-Type: application/octet-stream")
        builder.appendLine()
        builder.appendLine(filecontent)
        builder.appendLine(`--${boundary}--`)

        const res = await this.postRaw(`https://biro3.inf.u-szeged.hu/api/v1/students/exercises/${exerciseId}/submissions`, builder.value, {
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
        })
        const d: any = await res.json()
        return d
    }

    async getSubmissionStatus(submissionId: number) {
        return this.submissionStatuses[submissionId] ?? await this.fetchSubmissionStatus(submissionId)
    }

    async fetchSubmissionStatus(submissionId: number) {
        const v = await this.getJson<SubmissionStatus>(`https://biro3.inf.u-szeged.hu/api/v1/students/submissions/${submissionId}/status`)
        this.submissionStatuses[submissionId] = v
        return v
    }

    async getReports(evaluationId: number) {
        return this.reports[evaluationId] ?? await this.fetchReports(evaluationId)
    }

    async fetchReports(evaluationId: number): Promise<ReadonlyArray<{ filename: string; content: string | ReportContent }>> {
        const utf8Decoder = new TextDecoder()
        const v = await this.getJson<ReadonlyArray<{ filename: string; content: string; }>>(`https://biro3.inf.u-szeged.hu/api/v1/students/evaluations/${evaluationId}/reports`)
        for (const item of v) {
            const content = utf8Decoder.decode(Uint8Array.from(atob(item.content), v => v.charCodeAt(0)))
            try {
                const d = JSON.parse(content)
                item.content = d
            } catch (error) {
                item.content = content
            }
            const a = { "report_type": "BIRO3_SIMPLE", "tests": [{ "name": "M\u0171k\u00f6d\u00e9s", "tests": [{ "name": "Egyszer\u0171 \u00e9rt\u00e9kek", "score": 0, "max": 1, "message": "AssertionError: [1/3]\nArgumentum: 'egy', 'malacka', 'ha'\nElv\u00e1rt: 'EGYlackaEGYlacka'\nA tesztel\u00e9s sor\u00e1n kiv\u00e9tel keletkezett: TypeError(\"Popen.__init__() got an unexpected keyword argument 'shell'\")" }], "score": 0 }] }
        }
        this.reports[evaluationId] = v
        return v
    }

    async getSubmissionFiles(submissionId: number) {
        return this.submissionFiles[submissionId] ?? await this.fetchSubmissionFiles(submissionId)
    }

    async fetchSubmissionFiles(submissionId: number) {
        const utf8Decoder = new TextDecoder()
        const v = await this.getJson<ReadonlyArray<{ filename: string; content: string; }>>(`https://biro3.inf.u-szeged.hu/api/v1/students/submissions/${submissionId}/uploaded-files`);
        for (const item of v) {
            item.content = utf8Decoder.decode(Uint8Array.from(atob(item.content), v => v.charCodeAt(0)))
        }
        this.submissionFiles[submissionId] = v
        return v
    }
}

class BiroExplorerProvider implements vscode.TreeDataProvider<string> {
    readonly client: Biro3Client
    readonly extensionRoot: vscode.Uri

    constructor(client: Biro3Client, extensionRoot: vscode.Uri) {
        this.client = client
        this.extensionRoot = extensionRoot
    }

    private _onDidChangeTreeData = new vscode.EventEmitter<string | undefined>()
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event
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

            const assignment = this.client.assignments[subjectInstanceId]?.find(v => v.assignmentAssignedStudentId == assignmentAssignedStudentId)
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

        if (parts.length === 4) {
            const exerciseId = Number.parseInt(parts[2])
            const submissionId = Number.parseInt(parts[3])

            const submission = this.client.exercises[exerciseId]?.submissions.find(v => v.submissionId === submissionId)
            if (submission) {
                const item = new vscode.TreeItem(submission.name, vscode.TreeItemCollapsibleState.None)
                item.id = element
                //item.command = {
                //	command: "vscbiro.showSubmission",
                //	arguments: [submissionId],
                //	title: "Show info",
                //}
                return item
            }
        }

        return new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.Collapsed)
    }

    async getChildren(element?: string): Promise<string[]> {
        if (!element) {
            const subjectInstances = await this.client.withReauth(() => this.client.getSubjectInstances());
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

        if (parts.length === 3) {
            const subjectInstanceId = Number.parseInt(parts[0])
            const assignmentAssignedStudentId = Number.parseInt(parts[1])
            const exerciseId = Number.parseInt(parts[2])

            const d = await this.client.withReauth(() => this.client.getExercise(exerciseId))
            return d.submissions.map(v => `${subjectInstanceId}-${assignmentAssignedStudentId}-${exerciseId}-${v.submissionId}`)
        }

        return Promise.resolve([])
    }
}

let log: vscode.LogOutputChannel

export function activate(context: vscode.ExtensionContext) {
    log = vscode.window.createOutputChannel("Bíró 3 Debug", { log: true })

    const client = new Biro3Client()
    let selectedExerciseId: number | null = null

    //const submissionViews: Record<number, SubmissionPanel> = {}

    const explorerView = vscode.window.createTreeView('biro-courses', {
        treeDataProvider: new BiroExplorerProvider(client, context.extensionUri)
    })

    let exercisePanel: ExercisePanel | null = null

    const exerciseStatusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0)
    exerciseStatusItem.hide()

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
            exerciseStatusItem.text = (await client.withReauth(() => client.getExercise(exerciseId))).displayName
            exerciseStatusItem.show()

            vscode.commands.executeCommand("setContext", "vscbiro.allowSubmission", selectedExerciseId !== null)
        } catch (error) {
            log.error(String(error))
        }
    }))

    /*
    context.subscriptions.push(vscode.commands.registerCommand('vscbiro.showSubmission', async (submissionId: number) => {
        try {
            if (submissionViews[submissionId] && !submissionViews[submissionId].disposed) {
                submissionViews[submissionId].reveal()
            } else {
                submissionViews[submissionId] = SubmissionPanel.create(context.extensionUri, client, submissionId)
            }
        } catch (error) {
            log.error(String(error))
        }
    }))
    */

    context.subscriptions.push(vscode.commands.registerCommand('vscbiro.submit', async (fileUri: vscode.Uri) => {
        if (selectedExerciseId === null) {
            vscode.window.showErrorMessage(`Nincs kiválasztva feladat!`)
            return
        }
        const document = vscode.workspace.textDocuments.find(v => v.uri.path === fileUri.path && v.uri.query === fileUri.query && v.uri.scheme === fileUri.scheme && v.uri.fragment === fileUri.fragment && v.uri.authority === fileUri.authority)
        if (!document) {
            vscode.window.showErrorMessage(`File ${fileUri.toString()} not found`)
            return
        }
        if (document.isClosed) {
            vscode.window.showErrorMessage(`File ${fileUri.toString()} is closed`)
            return
        }
        log.debug(document.languageId)
        log.appendLine(document.getText())
    }))

    const myProvider = new class implements vscode.TextDocumentContentProvider {
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
    }
    vscode.workspace.registerTextDocumentContentProvider('birosubmission', myProvider)

    context.subscriptions.push(vscode.commands.registerCommand('vscbiro.openSubmittedFile', async (submissionId: number, filename: string) => {
        const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`birosubmission:${filename}?${submissionId}`));
        await vscode.window.showTextDocument(doc, { preview: true });
    }))

    if (vscode.window.registerWebviewPanelSerializer) {
        vscode.window.registerWebviewPanelSerializer(ExercisePanel.viewType, {
            async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: unknown) {
                log.debug(`Exercise webview deserialized`)
                exercisePanel = new ExercisePanel(webviewPanel, context.extensionUri, client, null, onExerciseViewDispose)
                webviewPanel.webview.options = getWebviewOptions(context.extensionUri)
            }
        })
    }
}

export function deactivate() { }

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
    return {
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')],
        enableScripts: true,
    }
}

class ExercisePanel {
    public static readonly viewType = 'exercise'

    public disposed: boolean
    private readonly panel: vscode.WebviewPanel
    private readonly extensionUri: vscode.Uri
    private readonly client: Biro3Client
    private readonly onDispose: () => void

    private exerciseId: number | null
    private disposables: Array<vscode.Disposable> = []

    public static create(extensionUri: vscode.Uri, client: Biro3Client, exerciseId: number, onDispose: () => void) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined

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
        this.client = client
        this.onDispose = onDispose

        this.update()

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables)

        this.panel.onDidChangeViewState(
            () => {
                if (this.panel.visible) {
                    this.update()
                }
            },
            null,
            this.disposables
        )

        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'refresh-submissions':
                        if (this.exerciseId === null) { return }
                        await this.client.withReauth(() => this.client.fetchExercise(this.exerciseId ?? 0))
                        await this.update()
                        return
                    case 'fetch-reports':
                        if (this.exerciseId === null) { return }
                        await this.client.withReauth(() => this.client.fetchReports(message.evaluationId))
                        await this.update()
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

    public refreshSubmissions() {
        this.panel.webview.postMessage({ command: 'refresh-submissions' })
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

    public reveal(exerciseId: number) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined

        this.panel.reveal(vscode.ViewColumn.Beside)

        this.exerciseId = exerciseId
        this.update()
    }

    private async update() {
        if (this.exerciseId === null) {
            return
        }

        try {
            const exercise = await this.client.withReauth(() => this.client.fetchExercise(this.exerciseId ?? 0))

            const tasks: Array<Promise<any>> = []
            for (const submission of exercise.submissions) {
                tasks.push(this.client.withReauth(() => this.client.getSubmissionStatus(submission.submissionId)))
                tasks.push(this.client.withReauth(() => this.client.getSubmissionFiles(submission.submissionId)))
                for (const evaluation of submission.evaluations) {
                    tasks.push(this.client.withReauth(() => this.client.getReports(evaluation.evaluationId)))
                }
            }
            Promise.allSettled(tasks)
                .then(() => this.exerciseId === exercise.assignedExerciseId && this.refreshHtml(exercise))
                .catch(error => log.error(String(error)))

            this.panel.title = `${exercise.indexInTaskList}. ${exercise.displayName}`
            this.refreshHtml(exercise)
        } catch (error) {
            log.error(String(error))
        }
    }

    private refreshHtml(exercise: Exercise) {
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
											<pre class="report">${v.content}</pre>
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
																	${v.message ? `<pre class="message">${v.message}</pre>` : ''}
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
					`).join()}
				</div>

				<script nonce="${nonce}" src="${this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'assets', 'main.js'))}"></script>
			</body>
			</html>`
    }
}

/*
class SubmissionPanel {
    public static readonly viewType = 'submission'

    public disposed: boolean
    private readonly panel: vscode.WebviewPanel
    private readonly extensionUri: vscode.Uri
    private readonly client: Biro3Client

    private submissionId: number
    private disposables: Array<vscode.Disposable> = []

    public static create(extensionUri: vscode.Uri, client: Biro3Client, submissionId: number) {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined

        const panel = vscode.window.createWebviewPanel(
            SubmissionPanel.viewType,
            `Submission ${submissionId}`,
            column || vscode.ViewColumn.One,
            getWebviewOptions(extensionUri)
        )

        return new SubmissionPanel(panel, extensionUri, client, submissionId)
    }

    private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, client: Biro3Client, submissionId: number) {
        this.disposed = false
        this.panel = panel
        this.extensionUri = extensionUri
        this.submissionId = submissionId
        this.client = client

        this.update()

        this.panel.onDidDispose(() => this.dispose(), null, this.disposables)

        this.panel.onDidChangeViewState(
            () => {
                if (this.panel.visible) {
                    this.update()
                }
            },
            null,
            this.disposables
        )
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
    }

    public reveal() {
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined

        this.panel.reveal(column)

        this.update()
    }

    private async update() {
        const nonce = getNonce()

        try {
            const files = await this.client.withReauth(() => this.client.fetchSubmissionFiles(this.submissionId))
            const status = await this.client.withReauth(() => this.client.fetchSubmissionStatus(this.submissionId))
            const reports = await this.client.withReauth(() => this.client.fetchReports(status.evaluationId))

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
            </head>
            <body>
                <div class="reports">
                    ${reports.map(v => `
                        <div class="report">
                            <h2>${v.filename}</h2>
                            ${(() => {
                                if (typeof v.content === 'string') {
                                    return `<pre class="message">${v.content}</pre>`
                                } else {
                                    return `
                                        report type: ${v.content.report_type} <br>
                                        tests: <br>
                                        ${v.content.tests.map(v => `
                                            <div>
                                                <h3>${v.name} - ${v.score} pont</h3>
                                                <div>
                                                    ${v.tests.map(v => `
                                                        <div>
                                                            <h4>${v.name} - ${v.score}/${v.max} pont</h4>
                                                            <pre class="message">${v.message}</pre>
                                                        </div>
                                                    `)}
                                                </div>
                                            </div>
                                        `)}
                                    `
                                }
                            })()}
                        </div>
                    `).join('')}
                </div>
                <div class="files">
                    ${files.map(v => `
                        <div class="file">
                            <h2>${v.filename}</h2>
                            <pre class="content">${v.content}</pre>
                        </div>
                    `).join('')}
                </div>
            </body>
            </html>`
        } catch (error) {
            log.error(String(error))
            return String(error)
        }
    }
}
*/

function getNonce() {
    let text = ''
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length))
    }
    return text
}
