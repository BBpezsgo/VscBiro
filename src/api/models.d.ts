export interface Assignment {
    readonly assignmentAssignedStudentId: number
    readonly startTime: string
    readonly endTime: string
    readonly assignmentName: string
    readonly assignmentDescription: string
    readonly assignmentType: string
    readonly maxScore: number
    readonly minScore: number
    readonly score: number | null
    readonly subjectName: string
    readonly semesterName: string
    readonly studentGroupName: unknown
    readonly studentGroupMembers: unknown
    readonly subjectInstanceId: number
    readonly postDeadlineHandling: "VIEW_ONLY" | "LOCKED" | "SUBMIT_WITH_NO_POINTS"
}

export interface StarterFile {
    readonly starterFileId: number
    readonly filename: string
    readonly viewable: boolean
    readonly copyable: boolean
    readonly downloadable: boolean
}

export interface Exercise {
    readonly assignedExerciseId: number
    readonly indexInTaskList: number
    readonly type: string
    readonly name: string
    readonly displayName: string
    readonly description: string
    readonly difficultyLevel: number
    readonly maxScore: number
    readonly minScore: number
    readonly uploadLimit: number
    readonly expectedFileFormat: string
    readonly timeLimit: unknown | null
    readonly starterFiles: ReadonlyArray<StarterFile>
    readonly taskImages: ReadonlyArray<unknown>
    readonly tags: ReadonlyArray<unknown>
    readonly score: number
    readonly submissions: ReadonlyArray<Submission>
}

export interface ExerciseStatus {
    readonly assignedExerciseId: number
    readonly exerciseIndex: number
    readonly exerciseState: "NO_SUBMISSION" | "COMPLETED" | "MAX" | "COMPLETED_ZERO"
}

export interface ReportContent {
    readonly report_type: string
    readonly tests: ReadonlyArray<ReportTestGroup>
}

export interface ReportTestGroup {
    readonly name: string
    readonly tests: ReadonlyArray<ReportTest>
    readonly score: number
}

export interface ReportTest {
    readonly name: string
    readonly score: number
    readonly max: number
    readonly message: string
}

export interface SubjectInstance {
    readonly subjectInstanceId: number
    readonly courseId: number
    readonly subjectCode: string
    readonly subjectName: string
    readonly semesterName: string
    readonly courseCode: string
    readonly courseDay: string
    readonly startTime: string
    readonly endTime: string
    readonly roomName: string
}

export interface Evaluation {
    readonly evaluationId: number
    readonly score: number
    readonly message: string
    readonly evaluationTime: string
}

export interface Submission {
    readonly submissionId: number
    readonly name: string
    readonly score: number
    readonly status: string
    readonly submissionTime: string
    readonly ipAddress: string
    readonly evaluations: ReadonlyArray<Evaluation>
}

export interface SubmissionStatus {
    state: "ERROR" | string
    finished: boolean
    score: number
    maxScore: number
    evaluationId: number
}
