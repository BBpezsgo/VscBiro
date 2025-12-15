import * as vscode from 'vscode'
import { ApiError } from './ApiError'
import { Assignment, Exercise, ExerciseStatus, ReportContent, SubjectInstance, SubmissionStatus } from './models'
import { log } from '../extension'

function parseCookies(response: Response): Readonly<Record<string, string>> {
    const cookies: Record<string, string> = {}
    for (const setCookie of response.headers.getSetCookie()) {
        const cookieName = setCookie.split('=')[0]
        const cookieValue = setCookie.substring(cookieName.length + 1).split(';')[0]
        cookies[cookieName] = cookieValue
    }
    return cookies
}

function listToRecord<K extends string | number, T>(items: ReadonlyArray<T>, key: (item: T) => K): Record<K, T> {
    const res: Record<any, T> = {}
    for (const item of items) {
        res[key(item)] = item
    }
    return res
}

export class Biro3Client {
    private username: string | null
    private password: string | null
    private accessToken: string | null
    private refreshToken: string | null

    subjectInstances: Record<number, SubjectInstance> | null
    assignments: Record<number, ReadonlyArray<Assignment>>
    assignmentDetails: Record<number, { assignmentDetails: Assignment; exerciseStatuses: ReadonlyArray<ExerciseStatus> }>
    exercises: Record<number, Exercise>
    submissionStatuses: Record<number, SubmissionStatus>
    reports: Record<number, ReadonlyArray<{ filename: string; content: string | ReportContent }>>
    submissionFiles: Record<number, ReadonlyArray<{ filename: string; content: string }>>

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

    //#region Utilities

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
                                } else {
                                    log.error("No saved username or password (this should never happen)")
                                }
                                break
                            default:
                                break
                        }
                    } else {
                        log.warn(`HTTP ${error.status.toString()}`)
                    }
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

        log.debug(`GET ${url}`)
        const res = await fetch(url, {
            credentials: 'include',
            headers: headers,
            method: 'GET',
            mode: 'cors'
        })

        if (!res.ok) {
            throw await ApiError.fromResponse(res)
        }

        this.refreshToken = parseCookies(res)['refresh-token'] ?? this.refreshToken

        return res
    }

    async post(url: string, body: any): Promise<Response> {
        return await this.postRaw(url, JSON.stringify(body), {})
    }

    async postRaw(url: string, body: string, headers: Record<string, string>): Promise<Response> {
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

        log.debug(`POST ${url}\n${body}`)
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

        this.refreshToken = parseCookies(res)['refresh-token'] ?? this.refreshToken

        return res
    }

    //#endregion

    //#region Authentication

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
                    if (choice === "Újra") {
                        continue
                    }
                }
                throw error
            }
        } while (true)
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

    //#endregion

    async getSubjectInstance(instanceId: number) {
        return this.subjectInstances?.[instanceId] ?? (await this.fetchSubjectInstances())[instanceId]
    }

    async getSubjectInstances() {
        return this.subjectInstances ? Object.values(this.subjectInstances) : await this.fetchSubjectInstances()
    }

    async fetchSubjectInstances() {
        const v = await this.getJson<ReadonlyArray<SubjectInstance>>('https://biro3.inf.u-szeged.hu/api/v1/students/subject-instances')
        this.subjectInstances = listToRecord(v, v => v.subjectInstanceId)
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
        const v = await this.getJson<{ assignmentDetails: Assignment; exerciseStatuses: ReadonlyArray<ExerciseStatus> }>(`https://biro3.inf.u-szeged.hu/api/v1/students/assignments/${assignmentId}`)
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
        const v = await this.getJson<ReadonlyArray<{ filename: string; content: string }>>(`https://biro3.inf.u-szeged.hu/api/v1/students/evaluations/${evaluationId}/reports`)
        for (const item of v) {
            const content = utf8Decoder.decode(Uint8Array.from(atob(item.content), v => v.charCodeAt(0)))
            try {
                const d = JSON.parse(content)
                item.content = d
            } catch (error) {
                item.content = content
            }
        }
        this.reports[evaluationId] = v
        return v
    }

    async getSubmissionFiles(submissionId: number) {
        return this.submissionFiles[submissionId] ?? await this.fetchSubmissionFiles(submissionId)
    }

    async fetchSubmissionFiles(submissionId: number) {
        const utf8Decoder = new TextDecoder()
        const v = await this.getJson<ReadonlyArray<{ filename: string; content: string }>>(`https://biro3.inf.u-szeged.hu/api/v1/students/submissions/${submissionId}/uploaded-files`)
        for (const item of v) {
            item.content = utf8Decoder.decode(Uint8Array.from(atob(item.content), v => v.charCodeAt(0)))
        }
        this.submissionFiles[submissionId] = v
        return v
    }
}
