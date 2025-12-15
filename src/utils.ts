import { Assignment } from './api/models'

export function isAssignmentLocked(assignment: Assignment): false | "EARLY" | "LATE" {
    const startTime = Date.parse(assignment.startTime)
    const endTime = Date.parse(assignment.endTime)
    const now = Date.now()
    if (now < startTime) {
        return 'EARLY'
    } else if (now < endTime) {
        return false
    } else {
        return 'LATE'
    }
}
