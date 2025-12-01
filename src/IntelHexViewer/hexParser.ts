export interface MemoryBlock {
    address: number;
    length: number;
    data: string;
}

export class HexParser {
    public static parse(content: string): MemoryBlock[] {
        const lines = content.split(/\r?\n/).filter(line => line.trim());
        const blocks: MemoryBlock[] = [];
        let baseAddress = 0;
        let currentBlock: MemoryBlock | null = null;
        
        for (const line of lines) {
            if (!line.startsWith(':')) continue;
            
            const byteCount = parseInt(line.substr(1, 2), 16);
            const address = parseInt(line.substr(3, 4), 16);
            const recordType = parseInt(line.substr(7, 2), 16);
            const data = line.substr(9, byteCount * 2);
            
            if (recordType === 0x04) {
                baseAddress = parseInt(data, 16) << 16;
                currentBlock = null;
            } else if (recordType === 0x00 && byteCount > 0) {
                const fullAddress = baseAddress + address;
                
                if (currentBlock && currentBlock.address + currentBlock.length === fullAddress) {
                    currentBlock.data += data;
                    currentBlock.length += byteCount;
                } else {
                    currentBlock = {
                        address: fullAddress,
                        length: byteCount,
                        data: data
                    };
                    blocks.push(currentBlock);
                }
            }
        }
        
        return blocks;
    }
}
