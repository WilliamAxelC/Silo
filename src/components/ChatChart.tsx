import React from 'react';
import { View, Text } from 'react-native';
import { BarChart, LineChart, PieChart } from 'react-native-gifted-charts';
import { useAppTheme } from '../theme/useAppTheme';

interface ChatChartProps {
  type: string;
  data: string;
}

export function ChatChart({ type, data }: ChatChartProps) {
  const theme = useAppTheme();
  let parsedData: any[] = [];

  try {
    // Expected data format: [{"value": 10, "label": "Jan"}, {"value": 20, "label": "Feb"}]
    // Or just an array of numbers [10, 20] which we can map to {value: 10}
    const rawData = JSON.parse(data.replace(/&quot;/g, '"'));
    if (Array.isArray(rawData)) {
      parsedData = rawData.map((item, index) => {
        if (typeof item === 'number') {
          return { value: item, label: `${index + 1}` };
        }
        return item;
      });
    }
  } catch (e) {
    return (
      <View style={{ padding: 12, backgroundColor: theme.surface, borderRadius: 8, borderWidth: 1, borderColor: theme.border }}>
        <Text style={{ color: theme.expense }}>Failed to parse chart data.</Text>
      </View>
    );
  }

  if (parsedData.length === 0) {
    return null;
  }

  const commonProps = {
    textColor: theme.text,
    axesColor: theme.border,
    xAxisLabelTextStyle: { color: theme.textMuted, fontSize: 10 },
    yAxisTextStyle: { color: theme.textMuted, fontSize: 10 },
    frontColor: theme.primary,
  };

  return (
    <View style={{ marginVertical: 12, padding: 12, backgroundColor: theme.surface, borderRadius: 12, borderWidth: 1, borderColor: theme.border, alignItems: 'center' }}>
      {type === 'line' ? (
        <LineChart
          data={parsedData}
          color={theme.primary}
          dataPointsColor={theme.primary}
          thickness={2}
          {...commonProps}
        />
      ) : type === 'pie' ? (
        <PieChart
          data={parsedData.map((d, i) => ({ ...d, color: i % 2 === 0 ? theme.primary : theme.expense }))}
          radius={80}
          textColor="#fff"
        />
      ) : (
        <BarChart
          data={parsedData}
          barWidth={22}
          noOfSections={4}
          barBorderRadius={4}
          {...commonProps}
        />
      )}
    </View>
  );
}
