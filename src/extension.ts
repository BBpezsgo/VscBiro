import * as vscode from 'vscode';
// @ts-ignore
const marked: typeof import('marked') = require('marked');

class ApiError extends Error {
	readonly status: number;
	readonly statusMessage: string;
	readonly response: any;

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
	subjectInstanceId: number;
	courseId: number;
	subjectCode: string;
	subjectName: string;
	semesterName: string;
	courseCode: string;
	courseDay: string;
	startTime: string;
	endTime: string;
	roomName: string;
}

type Assignment = {
	assignmentAssignedStudentId: number;
	startTime: string;
	endTime: string;
	assignmentName: string;
	assignmentDescription: string;
	assignmentType: string;
	maxScore: number;
	minScore: number;
	score: number | null;
	subjectName: string;
	semesterName: string;
	studentGroupName: unknown;
	studentGroupMembers: unknown;
	subjectInstanceId: number;
	postDeadlineHandling: "VIEW_ONLY" | "LOCKED" | "SUBMIT_WITH_NO_POINTS";
}

type AssignmentDetails = {
	assignmentAssignedStudentId: number;
	startTime: string;
	endTime: string;
	assignmentName: string;
	assignmentDescription: string;
	assignmentType: string;
	maxScore: number;
	minScore: number;
	score: null;
	subjectName: string;
	semesterName: string;
	studentGroupName: null;
	studentGroupMembers: null;
	subjectInstanceId: number;
	postDeadlineHandling: string;
}

type ExerciseStatus = {
	assignedExerciseId: number;
	exerciseIndex: number;
	exerciseState: "NO_SUBMISSION" | "COMPLETED" | "MAX" | "COMPLETED_ZERO";
}

type Exercise = {
	assignedExerciseId: number;
	indexInTaskList: number;
	type: string;
	name: string;
	displayName: string;
	description: string;
	difficultyLevel: number;
	maxScore: number;
	minScore: number;
	uploadLimit: number;
	expectedFileFormat: string;
	timeLimit: null;
	starterFiles: {
		starterFileId: number;
		filename: string;
		viewable: boolean;
		copyable: boolean;
		downloadable: boolean;
	}[];
	taskImages: never[];
	tags: never[];
	score: number;
	submissions: {
		submissionId: number;
		name: string;
		score: number;
		status: string;
		submissionTime: string;
		ipAddress: string;
		evaluations: {
			evaluationId: number;
			score: number;
			message: string;
			evaluationTime: string;
		}[];
	}[];
}

function sleep(ms: number): Promise<void> { return new Promise(v => setTimeout(v, ms)); }

class Biro3Client {
	username: string | null
	password: string | null
	accessToken: string | null
	refreshToken: string | null

	subjectInstances: ReadonlyArray<SubjectInstance & {
		assignments?: ReadonlyArray<Assignment & {
			details?: AssignmentDetails;
			exercises?: ReadonlyArray<ExerciseStatus>;
		}>
	}>

	constructor() {
		this.username = null;
		this.password = null;
		this.accessToken = null;
		this.refreshToken = null;
		this.subjectInstances = [];
	}

	private static parseCookies(response: Response): Readonly<Record<string, string>> {
		const cookies: Record<string, string> = {};
		for (const setCookie of response.headers.getSetCookie()) {
			const cookieName = setCookie.split('=')[0];
			const cookieValue = setCookie.substring(cookieName.length + 1).split(';')[0];
			cookies[cookieName] = cookieValue;
		}
		return cookies;
	}

	async fetchSubjectInstances(): Promise<ReadonlyArray<SubjectInstance>> {
		const res = await this.get('https://biro3.inf.u-szeged.hu/api/v1/students/subject-instances');
		const d: any = await res.json();
		return d;
	}

	async fetchAccessToken(username: string, password: string): Promise<void> {
		const res = await this.post('https://biro3.inf.u-szeged.hu/api/v1/auth/login/student', {
			username: username,
			password: password,
		});

		this.username = username;
		this.password = password;

		const d: any = await res.json();
		this.accessToken = d['accessToken'];
	}

	async refreshAccessToken() {
		const res = await this.post('https://biro3.inf.u-szeged.hu/api/v1/auth/refresh-token', {
			withCredentials: true
		});

		const d: any = await res.json();
		this.accessToken = d['accessToken'];
	}

	async withReauth<TArgs extends Array<any>, TResult>(fetch: (...args: TArgs) => Promise<TResult>, ...args: TArgs): Promise<TResult> {
		if (!this.username || !this.password) {
			log.warn(`No username/password, asking the user ...`);
			await this.login();
			await sleep(500);
		}

		if (!this.accessToken && this.username && this.password) {
			log.warn(`No access token, logging in again ...`);
			await this.fetchAccessToken(this.username, this.password);
			await sleep(500);
		}

		let retries = 0
		do {
			try {
				return await fetch(...args)
			} catch (error) {
				log.warn(`Trying to handle error: (${retries}) ${error}`);
				if (error instanceof ApiError && error.status === 401) {
					switch (retries++) {
						case 0:
						case 1:
							log.warn(`Refresh access token ...`)
							await this.refreshAccessToken()
							await sleep(500);
							continue;
						case 2:
						case 3:
							if (this.username && this.password) {
								log.warn(`Logging in again ...`)
								await this.fetchAccessToken(this.username, this.password)
								await sleep(500);
								continue;
							}
							break;					
						default:
							break;
					}
				}
				throw error
			}
		} while (true);
	}

	async get(url: string): Promise<Response> {
		log.debug(`GET ${url}`);

		let headers: Record<string, string> = {
			'Accept': 'application/json, text/plain, */*',
			'Accept-Language': 'en-US,en;q=0.5',
			'Sec-GPC': '1',
			'Sec-Fetch-Dest': 'empty',
			'Sec-Fetch-Mode': 'cors',
			'Sec-Fetch-Site': 'same-origin',
		};

		if (this.accessToken) {
			headers['Authorization'] = `Bearer ${this.accessToken}`;
		}

		if (this.refreshToken) {
			headers['Cookie'] = `refresh-token=${this.refreshToken}`;
		}

		const res = await fetch(url, {
			credentials: 'include',
			headers: headers,
			method: 'GET',
			mode: 'cors'
		});

		if (!res.ok) {
			throw await ApiError.fromResponse(res);
		}

		this.refreshToken = Biro3Client.parseCookies(res)['refresh-token'] ?? this.refreshToken;

		return res;
	}

	async post(url: string, body: any): Promise<Response> {
		log.debug(`POST ${url}\n${JSON.stringify(body, null, ' ')}`);

		let headers: Record<string, string> = {
			'Accept': 'application/json, text/plain, */*',
			'Accept-Language': 'en-US,en;q=0.5',
			'Content-Type': 'application/json',
			'Sec-GPC': '1',
			'Sec-Fetch-Dest': 'empty',
			'Sec-Fetch-Mode': 'cors',
			'Sec-Fetch-Site': 'same-origin',
		}

		if (this.accessToken) {
			headers['Authorization'] = `Bearer ${this.accessToken}`;
		}

		if (this.refreshToken) {
			headers['Cookie'] = `refresh-token=${this.refreshToken}`;
		}

		const res = await fetch(url, {
			credentials: 'include',
			headers: headers,
			body: JSON.stringify(body),
			method: 'POST',
			mode: 'cors'
		});

		if (!res.ok) {
			throw await ApiError.fromResponse(res);
		}

		this.refreshToken = Biro3Client.parseCookies(res)['refresh-token'] ?? this.refreshToken;

		return res;
	}

	async fetchAssignments(subject: number): Promise<ReadonlyArray<Assignment>> {
		const res = await this.get(`https://biro3.inf.u-szeged.hu/api/v1/students/subject-instances/${subject}/assignments`);
		const d: any = await res.json();
		return d;
	}

	async fetchAssignment(assignment: number): Promise<{ assignmentDetails: AssignmentDetails, exerciseStatuses: ReadonlyArray<ExerciseStatus> }> {
		const res = await this.get(`https://biro3.inf.u-szeged.hu/api/v1/students/assignments/${assignment}`);
		const d: any = await res.json();
		return d;
	}

	async fetchExercise(exerciseId: number): Promise<Exercise> {
		const res = await this.get(`https://biro3.inf.u-szeged.hu/api/v1/students/exercises/${exerciseId}`);
		const d: any = await res.json();
		return d;
	}

	async login() {
		do {
			const usernameInput: string = await vscode.window.showInputBox({
					password: false,
					title: 'Username',
					ignoreFocusOut: true,
				}) ?? '';
			const passwordInput: string = await vscode.window.showInputBox({
				password: true,
				title: 'Password',
				ignoreFocusOut: true,
			}) ?? '';

			try {
				return await this.fetchAccessToken(usernameInput, passwordInput);
			} catch (error) {
				log.error(String(error));
				if (error instanceof ApiError) {
					const choice = await vscode.window.showErrorMessage(error.response['message'], "Újra");
					if (choice === "Újra") continue;
				}
				throw error;
			}
		} while (true);
	}
}
class BiroProvider implements vscode.TreeDataProvider<string> {
	readonly client: Biro3Client;
	readonly extensionRoot: vscode.Uri;

	constructor(client: Biro3Client, extensionRoot: vscode.Uri) {
		this.client = client
		this.extensionRoot = extensionRoot
	}

	getTreeItem(element: string): vscode.TreeItem {
		const parts = element.split('-')
		if (parts.length === 1) {
			const subjectInstanceId = Number.parseInt(parts[0])

			const subject = this.client.subjectInstances.find(v => v.subjectInstanceId === subjectInstanceId)
			if (subject) {
				const item = new vscode.TreeItem(subject.subjectName, vscode.TreeItemCollapsibleState.Collapsed);
				item.description = `${subject.roomName} ${subject.startTime} - ${subject.endTime}`
				item.id = element
				item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'class.svg')
				return item
			}
		}

		if (parts.length === 2) {
			const subjectInstanceId = Number.parseInt(parts[0])
			const assignmentAssignedStudentId = Number.parseInt(parts[1])

			const subject = this.client.subjectInstances.find(v => v.subjectInstanceId === subjectInstanceId)
			if (subject) {
				const assignment = subject.assignments?.find(v => v.assignmentAssignedStudentId === assignmentAssignedStudentId)
				if (assignment) {
					const item = new vscode.TreeItem(assignment.assignmentName, vscode.TreeItemCollapsibleState.Collapsed);
					item.description = assignment.assignmentDescription;
					item.id = element;
					if (assignment.postDeadlineHandling === "LOCKED") {
						item.collapsibleState = vscode.TreeItemCollapsibleState.None;
						item.tooltip = "This assignment is locked";
						item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'lock.svg');
					} else if (assignment.score === null) {
						item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'no-submission.svg');
					} else if (assignment.score >= assignment.maxScore) {
						item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'pass.svg');
					} else if (assignment.score > assignment.minScore) {
						item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'in-progress.svg');
					} else if (assignment.score < assignment.maxScore) {
						item.iconPath = vscode.Uri.joinPath(this.extensionRoot, 'assets', 'error.svg');
					}
					return item
				}
			}
		}

		if (parts.length === 3) {
			const subjectInstanceId = Number.parseInt(parts[0])
			const assignmentAssignedStudentId = Number.parseInt(parts[1])
			const exerciseId = Number.parseInt(parts[2])

			const subject = this.client.subjectInstances.find(v => v.subjectInstanceId === subjectInstanceId)
			if (subject) {
				const assignment = subject.assignments?.find(v => v.assignmentAssignedStudentId === assignmentAssignedStudentId)
				if (assignment) {
					const exercise = assignment.exercises?.find(v => v.assignedExerciseId == exerciseId)
					if (exercise) {
						const item = new vscode.TreeItem(`${exercise.exerciseIndex}`, vscode.TreeItemCollapsibleState.Collapsed);
						item.id = element
						item.collapsibleState = vscode.TreeItemCollapsibleState.None;
						item.label = `${exercise.exerciseIndex}. feladat`;
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
							command: "vscbiro.showExerciseInfo",
							arguments: [exerciseId],
							title: "Show info",
						};
						return item;
					}
				}
			}
		}

		return new vscode.TreeItem(element, vscode.TreeItemCollapsibleState.Collapsed);
	}

	async getChildren(element?: string): Promise<string[]> {
		if (!element) {
			this.client.subjectInstances = await this.client.withReauth(() => this.client.fetchSubjectInstances())
			return this.client.subjectInstances.map(v => `${v.subjectInstanceId}`)
		}

		const parts = element.split('-')

		if (parts.length === 1) {
			const subjectInstanceId = Number.parseInt(parts[0])

			const subject = this.client.subjectInstances.find(v => v.subjectInstanceId === subjectInstanceId)
			if (subject) {
				subject.assignments = await this.client.withReauth(v => this.client.fetchAssignments(v), subject.subjectInstanceId)
				return subject.assignments?.map(v => `${subjectInstanceId}-${v.assignmentAssignedStudentId}`) ?? []
			}
		}

		if (parts.length === 2) {
			const subjectInstanceId = Number.parseInt(parts[0])
			const assignmentAssignedStudentId = Number.parseInt(parts[1])

			const subject = this.client.subjectInstances.find(v => v.subjectInstanceId === subjectInstanceId)
			if (subject) {
				const assignment = subject.assignments?.find(v => v.assignmentAssignedStudentId = assignmentAssignedStudentId)
				if (assignment) {
					if (assignment.postDeadlineHandling === "LOCKED") {
						return Promise.resolve([])
					}
					const d = await this.client.withReauth(v => this.client.fetchAssignment(v), assignment.assignmentAssignedStudentId)
					assignment.details = d.assignmentDetails
					assignment.exercises = d.exerciseStatuses
					return d.exerciseStatuses.map(v => `${subjectInstanceId}-${assignmentAssignedStudentId}-${v.assignedExerciseId}`)
				}
			}
		}

		return Promise.resolve([])
	}
}

let log: vscode.LogOutputChannel

export function activate(context: vscode.ExtensionContext) {
	log = vscode.window.createOutputChannel("Bíró 3 Debug", { log: true });

	const client = new Biro3Client()

	vscode.window.createTreeView('biroExplorer', {
		treeDataProvider: new BiroProvider(client, context.extensionUri)
	});

	const exercisePanels: Record<number, ExercisePanel> = {}

	context.subscriptions.push(vscode.commands.registerCommand('vscbiro.showExerciseInfo', async (exerciseId: number) => {
		try {
			if (exercisePanels[exerciseId] && !exercisePanels[exerciseId].disposed) {
				exercisePanels[exerciseId].reveal()
			} else {
				exercisePanels[exerciseId] = ExercisePanel.create(context.extensionUri, client, exerciseId);
			}
		} catch (error) {
			log.error(String(error));
		}
	}))

	if (vscode.window.registerWebviewPanelSerializer) {
		// Make sure we register a serializer in activation event
		vscode.window.registerWebviewPanelSerializer(ExercisePanel.viewType, {
			async deserializeWebviewPanel(webviewPanel: vscode.WebviewPanel, state: unknown) {
				log.debug(`Got state: ${state}`);
				// Reset the webview options so we use latest uri for `localResourceRoots`.
				webviewPanel.webview.options = getWebviewOptions(context.extensionUri);
				//AssignmentPanel.revive(webviewPanel, context.extensionUri);
			}
		});
	}
}

export function deactivate() { }

function getWebviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
	return {
		localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'assets')],
	};
}

class ExercisePanel {
	public static readonly viewType = 'assignment';

	public disposed: boolean;
	private readonly panel: vscode.WebviewPanel;
	private readonly extensionUri: vscode.Uri;
	private readonly exerciseId: number;
	private readonly client: Biro3Client;
	private disposables: Array<vscode.Disposable> = [];

	public static create(extensionUri: vscode.Uri, client: Biro3Client, exerciseId: number) {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		const panel = vscode.window.createWebviewPanel(
			ExercisePanel.viewType,
			'Exercise Details',
			column || vscode.ViewColumn.One,
			getWebviewOptions(extensionUri)
		);

		return new ExercisePanel(panel, extensionUri, client, exerciseId);
	}

	private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, client: Biro3Client, exerciseId: number) {
		this.disposed = false;
		this.panel = panel;
		this.extensionUri = extensionUri;
		this.exerciseId = exerciseId
		this.client = client

		this.update();

		this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

		this.panel.onDidChangeViewState(
			() => {
				if (this.panel.visible) {
					this.update();
				}
			},
			null,
			this.disposables
		);

		//// Handle messages from the webview
		//this.panel.webview.onDidReceiveMessage(
		//	message => {
		//		switch (message.command) {
		//			case 'alert':
		//				vscode.window.showErrorMessage(message.text);
		//				return;
		//		}
		//	},
		//	null,
		//	this.disposables
		//);
	}

	//public doRefactor() {
	//	// Send a message to the webview webview.
	//	// You can send any JSON serializable data.
	//	this.panel.webview.postMessage({ command: 'refactor' });
	//}

	public dispose() {
		this.disposed = true;

		this.panel.dispose();

		while (this.disposables.length) {
			const x = this.disposables.pop();
			if (x) {
				x.dispose();
			}
		}
	}

	public reveal() {
		const column = vscode.window.activeTextEditor
			? vscode.window.activeTextEditor.viewColumn
			: undefined;

		this.panel.reveal(column)
	}

	private async update() {
		const nonce = getNonce();

		try {
			const details = await this.client.withReauth(v => this.client.fetchExercise(v), this.exerciseId)
			this.panel.title = `${details.indexInTaskList}. ${details.displayName}`;
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
				<h1>${details.indexInTaskList}. ${details.displayName} (${details.maxScore} pont)</h1>
				<div class="description">
					${marked.parse(details.description, { async: false })}
				</div>
			</body>
			</html>`;
		} catch (error) {
			log.error(String(error))
			return String(error)
		}
	}
}

function getNonce() {
	let text = '';
	const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	for (let i = 0; i < 32; i++) {
		text += possible.charAt(Math.floor(Math.random() * possible.length));
	}
	return text;
}
