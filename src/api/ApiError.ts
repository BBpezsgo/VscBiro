export class ApiError extends Error {
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
        let data: any = null

        try {
            if (contentType === "application/json") {
                const d = data = await response.json()
                if (d && typeof d === 'object' && 'message' in d) {
                    message = String(d['message'])
                }
            } else {
                message = data = await response.text()
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

        return new ApiError(response.status, response.statusText, data, message)
    }
}
