// Ticket status colours (Python app: TICKET_STATUS_COLORS, TICKET_STATUS_GRADIENTS).

export const TICKET_STATUS_COLORS: Record<string, string> = {
    'Completed': '#f4d46f',
    'In progress': '#d2a746',
    'Declined': '#b2853a',
    'New': '#8e662a',
    'Cancelled': '#5d401d',
    'Unknown': '#7b6a47',
};

const GRADIENTS: Record<string, [string, string, string]> = {
    'Completed': ['#fff0a9', '#f4d46f', '#b8872d'],
    'In progress': ['#e5bf64', '#d2a746', '#8e662a'],
    'Declined': ['#c79a4d', '#a77832', '#68491f'],
    'New': ['#aa7a35', '#80591f', '#3c2913'],
    'Cancelled': ['#7a5528', '#4e3417', '#1b1209'],
    'Unknown': ['#a49468', '#7b6a47', '#312616'],
};

export function ticketStatusGradient(status: string): string {
    const [top, middle, bottom] = GRADIENTS[status] ?? ['#e5bf64', '#9f7531', '#342413'];
    return `linear-gradient(180deg, ${top} 0%, ${middle} 48%, ${bottom} 100%)`;
}
