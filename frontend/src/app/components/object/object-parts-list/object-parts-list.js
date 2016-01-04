import template from './object-parts-list.html';
import ko from 'knockout';
import { formatSize } from 'utils';

const partStateIconMapping = Object.freeze({
	available: 	'/fe/assets/icons.svg#part-available',
	in_process: '/fe/assets/icons.svg#part-in-process',
	unavailable:'/fe/assets/icons.svg#part-unavailable' 
});

class ObjectPartsListViewModel {
	constructor({ parts }) {
		this.parts = parts.map(
			part => this._mapPart(parts, part)
		);
	}

	expendPart(part) {
		part.isExpended(!part.isExpended());
	}

	_mapPart(parts, part) {
		let partsNumber = part.part_sequence_number + 1;
		let size = formatSize(part.chunk.size);
		let state = part.chunk.adminfo.health;

		let blocks = part.frags[0].blocks.map(
			block =>  {
				let { online, node_ip, node_name, pool_name } = block.adminfo;

				return {
					nodeStateIcon: `/fe/assets/icons.svg#node-${online ? 'online' : 'offline'}`,
					nodeIp: node_ip,
					nodeName: node_name,
					href: `/fe/systems/:system/pools/${pool_name}/nodes/${node_name}`
				}
			}
		);

		return {
			stateIcon: partStateIconMapping[state],
			name: `Part ${partsNumber} of ${parts().length}`,
			size: size,
			blocks: blocks,
			isExpended: ko.observable(parts().length === 1)
		}
	}
}

export default {
	viewModel: ObjectPartsListViewModel,
	template: template
}